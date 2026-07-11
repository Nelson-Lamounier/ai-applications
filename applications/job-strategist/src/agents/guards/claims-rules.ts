/**
 * @format
 * Deterministic claim enforcement: certification years, compliance overclaims,
 * metric-stuffed bullets, prohibited / bridge-required claims, scoped-claim
 * qualifiers, the keyAchievements section drop, and em-dash normalisation.
 */
import { normalizeProse } from '@bedrock/shared';
import type { StructuredResumeData } from '@bedrock/shared';
import type { ResumeViolation } from './types.js';
import { SENTENCE_SPLIT, numbersIn } from './text.js';

/**
 * Certification years are verified facts, not model output — the strategist
 * emitted (2024) for a 2025 certification, borrowing the year from education
 * dates. Enforce the verified date in both the certifications array and any
 * "Name (YYYY)" prose mention.
 */
export function enforceCertYears(resume: StructuredResumeData, verified: ReadonlyArray<{ name: string; date: string }>): { resume: StructuredResumeData; violations: ResumeViolation[] } {
    if (verified.length === 0) return { resume, violations: [] };
    let changed = false;
    let out = resume;
    for (const v of verified) {
        const year = /\b(20\d{2})\b/.exec(v.date)?.[1];
        if (!year) continue;
        const certs = (out.certifications ?? []).map((c) => {
            const entry = c as { name?: string; year?: string };
            if (entry.name && entry.name.toLowerCase().includes(v.name.toLowerCase().slice(0, 20)) && entry.year !== year) {
                changed = true;
                return { ...c, year };
            }
            return c;
        });
        const namePattern = v.name.slice(0, 25).replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
        const proseRe = new RegExp(String.raw`(${namePattern}[^()]{0,30}\()(20\d{2})(\))`, 'i');
        const summary = (out.summary ?? '').replace(proseRe, (m, pre, y, post) => {
            if (y !== year) { changed = true; return `${pre}${year}${post}`; }
            return m;
        });
        out = { ...out, certifications: certs, summary };
    }
    if (!changed) return { resume, violations: [] };
    return { resume: out, violations: [{ code: 'cert_year_corrected', detail: 'Certification year did not match the verified career-history date — corrected deterministically.' }] };
}

const COMPLIANCE_FRAMEWORK_RE = /\b(hipaa|pci[\s-]?dss|nist[\s-]?800-53)\b/i;
const COMPLIANCE_CLAIM_RE = /\bcomplian(?:ce|t)\b|\benforcing\b/i;
const RULE_PACK_RE = /rule\s*packs?|policy-as-code/i;

/**
 * Naming a framework next to "compliance"/"enforcing" without rule-pack
 * framing implies regulated compliance the candidate does not have — an
 * interviewer probes PCI scope and the whole resume loses credibility.
 */
export function checkComplianceOverclaim(out: ResumeViolation[], resume: StructuredResumeData): void {
    const texts = [
        resume.summary ?? '',
        ...(resume.experience ?? []).flatMap((e) => e.highlights ?? []),
        ...(resume.projects ?? []).map((p) => p.description ?? ''),
    ];
    for (const text of texts) {
        for (const sentence of text.split(SENTENCE_SPLIT)) {
            if (COMPLIANCE_FRAMEWORK_RE.test(sentence) && COMPLIANCE_CLAIM_RE.test(sentence) && !RULE_PACK_RE.test(sentence)) {
                out.push({ code: 'compliance_overclaim', detail: `"${sentence.slice(0, 110)}…" implies regulated compliance — reframe as the mechanism: policy-as-code gate with CDK-Nag RULE PACKS (named as packs), failing the pipeline on CRITICAL/HIGH.` });
                return;
            }
        }
    }
}

/** A bullet carrying 3+ distinct numbers is an inventory, not evidence. */
export function checkMetricStuffedBullets(out: ResumeViolation[], resume: StructuredResumeData): void {
    for (const e of resume.experience ?? []) {
        for (const h of e.highlights ?? []) {
            if (numbersIn(h).size >= 3) {
                out.push({ code: 'bullet_metric_stuffed', detail: `Bullet carries ${numbersIn(h).size} numbers ("${h.slice(0, 90)}…") — keep the strongest IMPACT metric (or one before/after pair) and cut the inventory counts; when everything is quantified nothing stands out.` });
                return;
            }
        }
    }
}

// =============================================================================
// PROHIBITED / BRIDGE-REQUIRED CLAIMS (deterministic)
// =============================================================================

/**
 * Hard factual prohibitions, mirrored from the persona's ABSOLUTE RULES —
 * enforced in code because the prompt version was violated in production
 * (the A/B run's summary claimed "Terraform" flat; the transfer graph made
 * it attainable-transferable, but the mandatory bridge framing was dropped).
 *
 * Two classes:
 * - `replacement`: never claimable — deterministically substituted.
 * - `bridge`: claimable ONLY with transfer framing in the same sentence
 *   (e.g. "CDK, transferable to Terraform"); flat mentions are removed
 *   from skill lists and repaired in prose.
 */
export interface ProhibitedClaim {
    readonly term: RegExp;
    readonly label: string;
    /** Deterministic substitution (never-claimable class). */
    readonly replacement?: string;
    /** Same-sentence markers that make the mention honest (bridge class). */
    readonly bridge?: RegExp;
}

export const PROHIBITED_CLAIMS: readonly ProhibitedClaim[] = [
    { term: /\bservice\s+mesh\b/gi, label: 'service mesh', replacement: 'Traefik v3 ingress and cross-namespace routing' },
    { term: /\bterraform\b/gi,       label: 'Terraform',    bridge: /transferable|equivalent|similar to|analogous|via (aws )?cdk/i },
    { term: /\bgke\b/gi,             label: 'GKE',          bridge: /transferable|equivalent|similar to|analogous|via (aws )?eks/i },
    { term: /\baks\b/gi,             label: 'AKS',          bridge: /transferable|equivalent|similar to|analogous|via (aws )?eks/i },
    { term: /\bfine[- ]tuning\b|\bRLHF\b/gi, label: 'fine-tuning/RLHF', replacement: 'Bedrock API integration' },
    { term: /\bon[- ]call\b/gi,      label: 'on-call',      replacement: 'solo-operated' },
    { term: /\benterprise[- ]scale\b/gi, label: 'enterprise-scale', replacement: 'production' },
];

function sentenceHonest(sentence: string, claim: ProhibitedClaim): boolean {
    if (claim.replacement !== undefined) return false;
    return claim.bridge ? claim.bridge.test(sentence) : true;
}

/** Fix one prose string: substitute never-claimables; report unbridged mentions. */
function fixProse(text: string, claim: ProhibitedClaim, unbridged: string[]): string {
    if (claim.replacement !== undefined) {
        claim.term.lastIndex = 0;
        return text.replace(claim.term, claim.replacement);
    }
    for (const sentence of text.split(SENTENCE_SPLIT)) {
        claim.term.lastIndex = 0;
        if (claim.term.test(sentence) && !sentenceHonest(sentence, claim)) unbridged.push(claim.label);
    }
    return text;
}

/** Skill-list items: a flat prohibited/bridge-less term is removed from the item. */
function fixSkillItem(item: string, claim: ProhibitedClaim): string {
    claim.term.lastIndex = 0;
    if (!claim.term.test(item)) return item;
    if (claim.replacement !== undefined) { claim.term.lastIndex = 0; return item.replace(claim.term, claim.replacement); }
    if (claim.bridge?.test(item)) return item;
    claim.term.lastIndex = 0;
    return item.replace(claim.term, '').replaceAll(/,\s*,/g, ',').replaceAll(/\(\s*,|,\s*\)/g, (m) => m.includes('(') ? '(' : ')').replaceAll(/\s{2,}/g, ' ').trim().replace(/^,|,$/g, '').trim();
}

/**
 * Deterministic prohibited-claims pass over every prose surface. Skill lists
 * are fixed in place; prose sentences with unbridged bridge-class terms are
 * reported for the bounded repair (deleting mid-sentence words mangles prose).
 */
export function enforceProhibitedClaims(resume: StructuredResumeData): { resume: StructuredResumeData; violations: ResumeViolation[] } {
    const unbridged: string[] = [];
    let out = resume;
    for (const claim of PROHIBITED_CLAIMS) {
        out = {
            ...out,
            summary: typeof out.summary === 'string' ? fixProse(out.summary, claim, unbridged) : out.summary,
            experience: (out.experience ?? []).map((e) => ({ ...e, highlights: (e.highlights ?? []).map((h) => fixProse(h, claim, unbridged)) })),
            projects: (out.projects ?? []).map((pr) => ({ ...pr, description: typeof pr.description === 'string' ? fixProse(pr.description, claim, unbridged) : pr.description })),
            skills: (out.skills ?? []).map((g) => ({ ...g, skills: (g.skills ?? []).map((it) => fixSkillItem(it, claim)).filter((it) => it.length > 0) })),
        };
    }
    const violations: ResumeViolation[] = [];
    if (JSON.stringify(out) !== JSON.stringify(resume)) {
        violations.push({ code: 'prohibited_claim_fixed', detail: 'Never-claimable terms substituted / flat bridge-class terms removed from skill lists.' });
    }
    const distinct = [...new Set(unbridged)];
    if (distinct.length > 0) {
        violations.push({ code: 'unbridged_transferable_claim', detail: `Flat mention of ${distinct.join(', ')} without transfer framing — restate with the honest bridge (e.g. "CDK, transferable to Terraform") or remove.` });
    }
    return { resume: out, violations };
}

// =============================================================================
// SCOPED-CLAIM ENFORCEMENT (deterministic)
// =============================================================================

/**
 * Evidence metrics that carry a mandatory scope qualifier. A claim using the
 * metric WITHOUT its qualifier overstates scope (the exact failure the
 * anti-fabrication positioning exists to prevent). Enforcement is section-
 * aware: sections that allow qualifiers get the qualifier appended; sections
 * where qualifiers are banned (summary, skills, projects) lose the metric.
 */
export interface ScopedClaim {
    /** Topic words that identify the claim in prose (with metricCore in the same string). */
    readonly context: RegExp;
    /** The metric's numeric core (e.g. inside a parenthetical). */
    readonly metricCore: RegExp;
    /** Present ⇒ the claim is properly scoped. */
    readonly qualifier: RegExp;
    /** Text appended when qualifying is allowed. */
    readonly qualifierText: string;
    readonly label: string;
}

export const SCOPED_CLAIMS: readonly ScopedClaim[] = [
    {
        context:       /cach|prompt/i,
        metricCore:    /~?\s{0,5}90\s{0,5}%/,
        qualifier:     /writer\s+lambda/i,
        qualifierText: '(Writer Lambda)',
        label:         'prompt-cache cost reduction',
    },
];

function isUnqualified(text: string, claim: ScopedClaim): boolean {
    return claim.metricCore.test(text) && claim.context.test(text) && !claim.qualifier.test(text);
}

/** Append the scope qualifier to the sentence carrying the metric. */
function qualifyClaim(text: string, claim: ScopedClaim): string {
    return text
        .split(SENTENCE_SPLIT)
        .map((s) => {
            if (!isUnqualified(s, claim)) return s;
            const trimmed = s.replace(/([.!?])$/, '');
            const punct = s.endsWith(trimmed) ? '' : s.slice(trimmed.length);
            return `${trimmed} ${claim.qualifierText}${punct}`;
        })
        .join(' ');
}

/**
 * Remove an unqualified scoped metric from prose: first drop a parenthetical
 * carrying it, then (if it survives outside parentheses) drop the sentence.
 */
function stripClaimFromProse(text: string, claim: ScopedClaim): string {
    const withoutParen = text.replace(/ ?\([^)]*\)/g, (m) => (claim.metricCore.test(m) ? '' : m));
    if (!isUnqualified(withoutParen, claim)) return withoutParen.trim();
    return withoutParen
        .split(SENTENCE_SPLIT)
        .filter((s) => !isUnqualified(s, claim))
        .join(' ')
        .trim();
}

function enforceClaimOnSkills(resume: StructuredResumeData, claim: ScopedClaim): StructuredResumeData {
    if (!Array.isArray(resume.skills)) return resume;
    const skills = resume.skills.map((group) => ({
        ...group,
        skills: (group.skills ?? [])
            .map((s) => (isUnqualified(s, claim) ? stripClaimFromProse(s, claim) : s))
            .filter((s) => s.length > 0 && !isUnqualified(s, claim)),
    }));
    return { ...resume, skills };
}

function enforceClaimOnHighlights(resume: StructuredResumeData, claim: ScopedClaim): StructuredResumeData {
    if (!Array.isArray(resume.experience)) return resume;
    const experience = resume.experience.map((e) => ({
        ...e,
        highlights: (e.highlights ?? []).map((h) => (isUnqualified(h, claim) ? qualifyClaim(h, claim) : h)),
    }));
    const keyAchievements = Array.isArray(resume.keyAchievements)
        ? resume.keyAchievements.map((k) => (
            typeof k.achievement === 'string' && isUnqualified(k.achievement, claim)
                ? { ...k, achievement: qualifyClaim(k.achievement, claim) }
                : k))
        : resume.keyAchievements;
    return { ...resume, experience, keyAchievements };
}

function enforceClaimOnProse(resume: StructuredResumeData, claim: ScopedClaim): StructuredResumeData {
    const summary = typeof resume.summary === 'string' && isUnqualified(resume.summary, claim)
        ? stripClaimFromProse(resume.summary, claim)
        : resume.summary;
    const projects = Array.isArray(resume.projects)
        ? resume.projects.map((p) => (
            typeof p.description === 'string' && isUnqualified(p.description, claim)
                ? { ...p, description: stripClaimFromProse(p.description, claim) }
                : p))
        : resume.projects;
    return { ...resume, summary, projects };
}

/**
 * There is NO separate Key Achievements section on the resume — achievement
 * material integrates into experience lead bullets and the summary metric
 * (prompt rule). When the model emits the section anyway, drop it and scrub
 * `sectionOrder`; the violation code keeps the event observable.
 */
export function dropKeyAchievementsSection(resume: StructuredResumeData): { resume: StructuredResumeData; violations: ResumeViolation[] } {
    const emitted = Array.isArray(resume.keyAchievements) && resume.keyAchievements.length > 0;
    const inOrder = Array.isArray(resume.sectionOrder) && resume.sectionOrder.includes('keyAchievements');
    if (!emitted && !inOrder) return { resume, violations: [] };
    const out: StructuredResumeData = {
        ...resume,
        keyAchievements: [],
        ...(Array.isArray(resume.sectionOrder)
            ? { sectionOrder: resume.sectionOrder.filter((k) => k !== 'keyAchievements') }
            : {}),
    };
    return {
        resume: out,
        violations: [{ code: 'key_achievements_emitted', detail: 'Strategist emitted a keyAchievements section — dropped; achievement material must be integrated into experience bullets and the summary metric.' }],
    };
}

/**
 * Deterministic, always-on pass: qualify scoped metrics where qualifiers are
 * allowed (experience highlights, key achievements), strip them where
 * qualifiers are banned (summary, skills, projects). Emits one violation per
 * claim that needed enforcement so the fix is observable.
 */
export function enforceScopedClaims(resume: StructuredResumeData): { resume: StructuredResumeData; violations: ResumeViolation[] } {
    let out = resume;
    const violations: ResumeViolation[] = [];
    for (const claim of SCOPED_CLAIMS) {
        const before = JSON.stringify(out);
        out = enforceClaimOnProse(enforceClaimOnSkills(enforceClaimOnHighlights(out, claim), claim), claim);
        if (JSON.stringify(out) !== before) {
            violations.push({ code: 'scoped_claim_unqualified', detail: `"${claim.label}" appeared without its scope qualifier — qualified in experience/achievements, removed from summary/skills/projects.` });
        }
    }
    return { resume: out, violations };
}

/** Normalize em-dashes in all prose fields of a StructuredResumeData. Defensive +
 *  shape-preserving: only transforms fields that are actually present (the guard is
 *  fail-open infra — never throw on a resume missing an optional array). */
export function stripEmDashes(resume: StructuredResumeData): StructuredResumeData {
    return {
        ...resume,
        ...(typeof resume.summary === 'string' ? { summary: normalizeProse(resume.summary) } : {}),
        ...(Array.isArray(resume.experience)
            ? { experience: resume.experience.map((e) => ({ ...e, highlights: Array.isArray(e.highlights) ? e.highlights.map((h) => normalizeProse(h)) : e.highlights })) }
            : {}),
        ...(Array.isArray(resume.projects)
            ? { projects: resume.projects.map((p) => ({ ...p, description: typeof p.description === 'string' ? normalizeProse(p.description) : p.description })) }
            : {}),
        ...(Array.isArray(resume.keyAchievements)
            ? { keyAchievements: resume.keyAchievements.map((k) => ({ ...k, achievement: typeof k.achievement === 'string' ? normalizeProse(k.achievement) : k.achievement })) }
            : {}),
    } as StructuredResumeData;
}
