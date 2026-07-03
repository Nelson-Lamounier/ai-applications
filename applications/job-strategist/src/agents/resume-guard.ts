/** @format */
import { runAgent, log, normalizeProse } from '@bedrock/shared';
import type { AgentConfig, BasePipelineContext, StructuredResumeData } from '@bedrock/shared';
import { ResumeRewriteSchema, buildEmitResumeTool } from './resume-tool-schema.js';

export interface ResumeViolation { code: string; detail: string; }
export interface ResumeGuardCtx {
    targetRole: string;
    leadIdentity: string;
    verifiedEducation: string[];
    archetypeSkillLead: string;
    /** The JD's company problem — the summary's mandatory bridge target. */
    companyProblem?: string;
    /** Documented project pitches — the opening beat a project description must use. */
    projectPitches?: ReadonlyArray<{ name: string; pitch: string }>;
    /** Verified certifications (name + date string) — years are enforced, not trusted. */
    verifiedCertifications?: ReadonlyArray<{ name: string; date: string }>;
}

const GAP_RE = /falls?\s+short|\b\d{1,2}\s*years?\b[^.]{0,40}\b(?:short|threshold|bar|requirement|fall)|do(?:es)?\s*not\s+yet\s+have/i;

/**
 * Generic stop-words that appear in many identities and are not differentiating
 * (e.g. "engineer", "builds", "years", "with", "who").
 */
const GENERIC_TOKENS = new Set(['engineer', 'builds', 'build', 'years', 'with', 'from', 'that', 'this', 'have', 'been', 'into', 'your', 'their', 'where', 'what', 'will', 'more', 'over', 'about', 'some', 'when', 'than', 'like']);

/** Job-title nouns that must not appear in a positioning headline's lead segment. */
const TITLE_NOUNS = new Set(['engineer', 'engineering', 'associate', 'analyst', 'manager', 'developer', 'specialist', 'lead', 'architect', 'consultant', 'administrator', 'coordinator', 'technician', 'officer', 'director', 'assistant', 'representative', 'agent', 'scientist']);

/** A "Selected work"/GitHub highlight must not sit under a support/customer/QA role. */
const SUPPORT_ROLE_RE = /support|customer|service|associate|quality assurance|\bqa\b|help\s?desk|technician/i;
const SELECTED_WORK_RE = /selected work|github\.com/i;

/**
 * Returns the distinctive lead tokens from the identity string — words that
 * identify the archetype cluster (e.g. "support", "production") — by taking
 * the first token that is not in GENERIC_TOKENS.
 */
function leadClusterTokens(leadIdentity: string): string[] {
    const all = leadIdentity.toLowerCase().split(/[^a-z]+/).filter((t) => t.length > 3);
    return all.filter((t) => !GENERIC_TOKENS.has(t));
}

/** Returns the support/customer role title whose highlights hold a Selected-work/GitHub line, else null. */
function findMisplacedSelectedWork(resume: StructuredResumeData): string | null {
    for (const e of resume.experience ?? []) {
        if (SUPPORT_ROLE_RE.test(e.title) && (e.highlights ?? []).some((h) => SELECTED_WORK_RE.test(h))) {
            return e.title;
        }
    }
    return null;
}

/** Numbers (integers with optional +) appearing in a prose string. */
function numbersIn(text: string): Set<string> {
    return new Set((text.match(/\d+(?:[.,]\d+)?\+?/g) ?? []).map((n) => n.replace(/[,+]/g, '')));
}

/** Distinct numbers the summary shares with experience bullets. */
export function summarySharedNumbers(resume: StructuredResumeData): string[] {
    const summaryNums = numbersIn(resume.summary ?? '');
    if (summaryNums.size === 0) return [];
    const bulletNums = numbersIn((resume.experience ?? []).flatMap((e) => e.highlights ?? []).join(' '));
    return [...summaryNums].filter((n) => bulletNums.has(n));
}

/**
 * The summary POSITIONS, bullets PROVE — a summary that restates bullet
 * headline numbers is an inventory, not a positioning statement (the
 * Accenture run's summary repeated 16-CDK-stack + 30 Checkov rules from
 * bullets 2 and 4). One shared number is allowed: the closing metric.
 */
function checkSummaryInventory(out: ResumeViolation[], resume: StructuredResumeData): void {
    const sharedNumbers = summarySharedNumbers(resume);
    if (sharedNumbers.length > 0) {
        out.push({ code: 'summary_restates_bullets', detail: `Summary repeats ${sharedNumbers.length} number(s) already used in experience bullets (${sharedNumbers.join(', ')}) — the ladder rule: summary states the shape, bullets substantiate; convey rigor qualitatively and keep counts in the bullets.` });
    }
}

/**
 * Projects share the summary's contract: they POSITION (pitch + differentiator
 * + one fresh metric); bullets PROVE. A description sharing more than one
 * number with the experience bullets is a restated inventory (the Accenture
 * run's AI-Platform description repeated 16-CDK-stack and 25 ArgoCD apps).
 */
function checkProjectInventory(out: ResumeViolation[], resume: StructuredResumeData): void {
    const bulletNums = numbersIn((resume.experience ?? []).flatMap((e) => e.highlights ?? []).join(' '));
    for (const p of resume.projects ?? []) {
        const shared = [...numbersIn(p.description ?? '')].filter((n) => bulletNums.has(n));
        if (shared.length > 1) {
            out.push({ code: 'project_restates_bullets', detail: `Project "${p.name}" repeats ${shared.length} numbers already used in experience bullets (${shared.join(', ')}) — open with the documented pitch, add one JD-relevant differentiator, one fresh metric.` });
        }
    }
}

const ECHO_STOPWORDS = new Set([
    'production', 'platform', 'platforms', 'systems', 'infrastructure', 'engineering', 'delivery',
    'through', 'across', 'every', 'before', 'spanning', 'applies', 'builds', 'build', 'built',
    'and', 'the', 'via', 'end', 'with', 'for', 'from', 'that', 'this', 'into', 'are', 'has',
    'have', 'was', 'were', 'per', 'all', 'one', 'two', 'its', 'our', 'their', 'work', 'using',
]);

/** Content tokens (len >= 3 so tech acronyms like EKS/CDK/IaC count; non-generic). */
function contentTokens(text: string): string[] {
    return (text.toLowerCase().match(/[a-z][a-z0-9+-]{2,}/g) ?? []).filter((t) => !ECHO_STOPWORDS.has(t));
}

/**
 * Summary sentences that topically ECHO the experience bullets (>= 60% of a
 * sentence's content tokens already appear in bullets, min 4 hits). Number
 * overlap catches restated metrics; this catches restated TOPICS — the run
 * that motivated it summarised "secure CI/CD, Kubernetes on EKS, multi-account
 * IaC, observability": four bullet headlines re-listed with one shared number.
 */
export function summaryEchoSentences(resume: StructuredResumeData): string[] {
    const bulletTokens = new Set(contentTokens((resume.experience ?? []).flatMap((e) => e.highlights ?? []).join(' ')));
    if (bulletTokens.size === 0) return [];
    return (resume.summary ?? '').split(/(?<=[.!?])\s+/).filter((sentence) => {
        const tokens = contentTokens(sentence);
        if (tokens.length < 4) return false;
        const hits = tokens.filter((t) => bulletTokens.has(t)).length;
        return hits >= 4 && hits / tokens.length >= 0.6;
    });
}

function checkSummaryEcho(out: ResumeViolation[], resume: StructuredResumeData): void {
    const echoes = summaryEchoSentences(resume);
    if (echoes.length > 0) {
        out.push({ code: 'summary_echoes_bullets', detail: `Summary sentence(s) topically restate experience bullets: "${echoes[0].slice(0, 120)}…" — the summary positions (problem bridge, distinctive angle); bullets prove.` });
    }
}

/** The summary must visibly bridge to the JD's company problem (>= 2 distinctive problem tokens present). */
function checkProblemBridge(out: ResumeViolation[], resume: StructuredResumeData, companyProblem?: string): void {
    if (!companyProblem) return;
    const problemTokens = new Set(contentTokens(companyProblem));
    if (problemTokens.size < 3) return;
    const summaryTokens = new Set(contentTokens(resume.summary ?? ''));
    const hits = [...problemTokens].filter((t) => summaryTokens.has(t)).length;
    if (hits < 2) {
        out.push({ code: 'summary_missing_problem_bridge', detail: 'Summary never bridges to the JD\'s company problem — one sentence must connect the candidate\'s approach to the problem this role exists to solve.' });
    }
}

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
        const proseRe = new RegExp(`(${namePattern}[^()]{0,30}\\()(20\\d{2})(\\))`, 'i');
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
function checkComplianceOverclaim(out: ResumeViolation[], resume: StructuredResumeData): void {
    const texts = [
        resume.summary ?? '',
        ...(resume.experience ?? []).flatMap((e) => e.highlights ?? []),
        ...(resume.projects ?? []).map((p) => p.description ?? ''),
    ];
    for (const text of texts) {
        for (const sentence of text.split(/(?<=[.!?])\s+/)) {
            if (COMPLIANCE_FRAMEWORK_RE.test(sentence) && COMPLIANCE_CLAIM_RE.test(sentence) && !RULE_PACK_RE.test(sentence)) {
                out.push({ code: 'compliance_overclaim', detail: `"${sentence.slice(0, 110)}…" implies regulated compliance — reframe as the mechanism: policy-as-code gate with CDK-Nag RULE PACKS (named as packs), failing the pipeline on CRITICAL/HIGH.` });
                return;
            }
        }
    }
}

/** A bullet carrying 3+ distinct numbers is an inventory, not evidence. */
function checkMetricStuffedBullets(out: ResumeViolation[], resume: StructuredResumeData): void {
    for (const e of resume.experience ?? []) {
        for (const h of e.highlights ?? []) {
            if (numbersIn(h).size >= 3) {
                out.push({ code: 'bullet_metric_stuffed', detail: `Bullet carries ${numbersIn(h).size} numbers ("${h.slice(0, 90)}…") — keep the strongest IMPACT metric (or one before/after pair) and cut the inventory counts; when everything is quantified nothing stands out.` });
                return;
            }
        }
    }
}

export function validateResume(resume: StructuredResumeData, ctx: ResumeGuardCtx): ResumeViolation[] {
    const out: ResumeViolation[] = [];
    const title = resume.profile.title.trim();

    const hasSeparator = /[·—|]/.test(title);
    const employmentTitles = new Set(resume.experience.map((e) => e.title.toLowerCase().trim()));
    const leadSeg = title.split(/[·—|]/)[0].trim().toLowerCase();
    const hasTitleNoun = leadSeg.split(/\s+/).some((w) => TITLE_NOUNS.has(w));
    if (title && (!hasSeparator || employmentTitles.has(title.toLowerCase()) || hasTitleNoun)) {
        out.push({ code: 'headline_is_title', detail: `profile.title "${title}" reads as a job-title claim — it must be a descriptive domain/capability headline with NO job-title noun (Engineer, Associate, Analyst, Manager, Developer, Specialist, Lead, Architect…).` });
    }

    const summary = resume.summary.trim();
    const firstSentence = summary.split(/(?<=[.!?])\s/)[0]?.toLowerCase() ?? '';
    const tokens = leadClusterTokens(ctx.leadIdentity);
    if (summary && tokens.length > 0 && !tokens.some((t) => firstSentence.includes(t))) {
        out.push({ code: 'summary_wrong_cluster', detail: 'Summary opener does not lead with the archetype lead-identity differentiator.' });
    }

    if (GAP_RE.test(summary)) {
        out.push({ code: 'summary_names_gap', detail: 'Summary names/concedes the experience gap.' });
    }

    const verifiedLower = new Set(ctx.verifiedEducation.map((v) => v.toLowerCase()));
    for (const ed of resume.education) {
        const deg = ed.degree.toLowerCase();
        if (deg && !Array.from(verifiedLower).some((v) => v.includes(deg) || deg.includes(v))) {
            out.push({ code: 'education_mismatch', detail: `Education "${ed.degree}" not in the verified facts.` });
            break;
        }
    }

    if (ctx.archetypeSkillLead) {
        const firstCat = (resume.skills[0]?.category ?? '').toLowerCase();
        if (firstCat && firstCat !== ctx.archetypeSkillLead.toLowerCase()) {
            out.push({ code: 'skills_lead_mismatch', detail: `First skill group "${resume.skills[0]?.category}" is not the archetype lead "${ctx.archetypeSkillLead}".` });
        }
    }

    checkSummaryInventory(out, resume);
    checkProjectInventory(out, resume);
    checkSummaryEcho(out, resume);
    checkProblemBridge(out, resume, ctx.companyProblem);
    checkComplianceOverclaim(out, resume);
    checkMetricStuffedBullets(out, resume);

    const misplaced = findMisplacedSelectedWork(resume);
    if (misplaced) {
        out.push({ code: 'selected_work_misplaced', detail: `"Selected work"/GitHub links appear under the support/customer role "${misplaced}" — they must sit under a builder/engineering role (e.g. Freelance / Cloud & DevOps), or a Projects section.` });
    }

    return out;
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

const SENTENCE_SPLIT = /(?<=[.!?])\s+/;

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
        context:       /cach\w*|prompt/i,
        metricCore:    /~?\s*90\s*%/,
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
        .split(/(?<=[.!?])\s+/)
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
    const withoutParen = text.replace(/\s*\([^)]*\)/g, (m) => (claim.metricCore.test(m) ? '' : m));
    if (!isUnqualified(withoutParen, claim)) return withoutParen.trim();
    return withoutParen
        .split(/(?<=[.!?])\s+/)
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

// =============================================================================
// HAIKU REWRITE + GUARD ORCHESTRATOR
// =============================================================================

const MODEL_ID = process.env['RESUME_REWRITE_MODEL'] ?? 'eu.anthropic.claude-haiku-4-5-20251001-v1:0';

const RewriteSchema = ResumeRewriteSchema;

const TOOL = buildEmitResumeTool('Return the corrected resume as structured JSON (plain text strings, NO markdown).');

const CTX: BasePipelineContext = {
    pipelineId: 'resume-guard',
    environment: process.env['DEPLOY_ENV'] ?? 'dev',
    cumulativeTokens: { input: 0, output: 0, thinking: 0 },
    cumulativeCostUsd: 0,
};

/** Haiku rewrite that fixes ONLY the flagged issues. FAIL-OPEN: returns the input on error. */
export async function rewriteResume(
    resume: StructuredResumeData,
    violations: ResumeViolation[],
    ctx: ResumeGuardCtx,
): Promise<StructuredResumeData> {
    const system = [
        'You repair a tailored resume, fixing ONLY the listed issues by REORDERING and REWORDING for prominence. Call emit_resume with the full resume JSON.',
        `NEVER fabricate, NEVER change a number or date, NEVER rename a degree — the verified degree names are: ${ctx.verifiedEducation.join('; ')}.`,
        `Make the summary's FIRST sentence lead with this identity differentiator: "${ctx.leadIdentity}" — never an infrastructure-first opener; never name or concede any experience gap.`,
        ctx.projectPitches?.length
            ? `For project_restates_bullets: rewrite each flagged project description in three beats — (1) open with its documented pitch: ${ctx.projectPitches.map((p) => `"${p.name}: ${p.pitch.slice(0, 200)}"`).join(' | ')}; (2) ONE JD-relevant differentiator not already an experience bullet; (3) one metric not used elsewhere. No stack enumerations.`
            : 'For project_restates_bullets: rewrite the flagged project description as pitch (what it is, who it is for, the problem it solves) + one JD-relevant differentiator + one fresh metric. Remove numbers duplicated from experience bullets and all stack enumerations.',
        ctx.companyProblem ? `For summary_restates_bullets: rewrite the summary at ALTITUDE — S1 identity anchor + capability ("<Role-family> engineer who builds…"), S2 ONE sentence bridging to this problem (paraphrased): "${ctx.companyProblem.slice(0, 400)}", S3 the concrete paid-experience anchor, S4 qualitative rigor close ("every change gated by automated tests and policy-as-code"). Remove EVERY number that also appears in an experience bullet — counts belong to bullets.` : 'For summary_restates_bullets: rewrite the summary at altitude — identity anchor, problem bridge, concrete paid-experience anchor, qualitative rigor close; remove every number that also appears in an experience bullet.',
        'For headline_is_title: rewrite profile.title as a DESCRIPTIVE domain/capability headline with NO job-title noun (Engineer, Associate, Analyst, Manager, Developer, Specialist, Lead, Architect, Consultant…) — e.g. "Cloud & AI Operations · Python Automation & Incident Response". Never claim a role the candidate does not hold.',
        'For selected_work_misplaced: MOVE the "Selected work"/GitHub links highlight OUT of the support/customer/QA role and into the most senior builder/engineering role\'s highlights (e.g. Freelance / Cloud & DevOps). If no builder/engineering role exists, DROP that highlight. Never leave it under a support/customer-facing role.',
        `Put the "${ctx.archetypeSkillLead}" skill group FIRST (if present); within each group, JD-matched terms first.`,
        'Within each experience role, lead with the strongest number-led bullet.',
        'For compliance_overclaim: reframe as the MECHANISM — "policy-as-code gate (Checkov custom rules + CDK-Nag rule packs: HIPAA, NIST 800-53, PCI DSS) failing the pipeline on CRITICAL/HIGH misconfigurations". Frameworks named ONLY as rule packs, never as achieved compliance.',
        'For bullet_metric_stuffed: rewrite the flagged bullet(s) around ONE idea with the strongest IMPACT metric (or one before/after pair, e.g. "30 seconds vs 8 minutes"); move or drop inventory counts (N stacks, N workflows, N rules) — keep at most 3 inventory numbers across the whole experience section.',
        'For summary_echoes_bullets: DELETE the echoing sentence(s) and replace with (a) one sentence bridging to the company problem and (b) one distinctive angle that is NOT an experience bullet. The summary positions; bullets prove.',
        'For summary_missing_problem_bridge: add ONE sentence connecting the candidate\'s proven approach to the company problem (paraphrased, first sentence or second).',
        'For unbridged_transferable_claim: restate each flagged term with its honest transfer framing in the same clause (e.g. "AWS CDK, transferable to Terraform") — or remove the term. Never leave a flat claim of a tool the candidate has not used.',
        'NEVER increase total length: the corrected resume must have the SAME or FEWER total words than the input. A fix rewrites in place; it never adds new prose elsewhere.',
        'Preserve every fact, all education names verbatim, and the profile identity. Output plain-text strings, no markdown.',
    ].join('\n');

    const config: AgentConfig = {
        agentName: 'resume-rewrite',
        modelId: MODEL_ID,
        maxTokens: 8000,
        thinkingBudget: 0,
        systemPrompt: [{ text: system }],
        pipeline: 'job-strategist',
        tool: { name: TOOL.name, description: TOOL.description, inputSchema: TOOL.input_schema as Record<string, unknown> },
    };

    const userMessage = `<issues>${violations.map((v) => v.code).join(', ')}</issues>\n<resume>${JSON.stringify(resume)}</resume>`;

    try {
        const result = await runAgent<StructuredResumeData>({
            config, userMessage, pipelineContext: CTX,
            parseResponse: (s) => {
                const parsed = RewriteSchema.safeParse(JSON.parse(s));
                if (!parsed.success) throw new Error(`resume-rewrite: ${parsed.error.message}`);
                return parsed.data as unknown as StructuredResumeData;
            },
        });
        return result.data;
    } catch (e) {
        log('WARN', 'resume rewrite failed — keeping original', { error: e instanceof Error ? e.message : String(e) });
        return resume;
    }
}

/**
 * FINAL content re-validation — runs after the LAST mutating pass (migration
 * reframe, condense/expand, surface-keywords), because those passes were
 * observed reintroducing violations the early guard had already repaired
 * (the A/B run's project regained 5 bullet-shared numbers, and an unbridged
 * "Terraform" appeared in the summary). Deterministic checks + ONE bounded
 * repair; anything still violating after that is reported, never looped.
 */
export async function revalidateResumeContent(
    resume: StructuredResumeData,
    ctx: ResumeGuardCtx,
): Promise<{ resume: StructuredResumeData; violations: ResumeViolation[] }> {
    const prohibited = enforceProhibitedClaims(resume);
    const certs = enforceCertYears(prohibited.resume, ctx.verifiedCertifications ?? []);
    const scoped = enforceScopedClaims(certs.resume);
    let out = scoped.resume;
    const violations: ResumeViolation[] = [...prohibited.violations, ...certs.violations, ...scoped.violations];

    const inventory: ResumeViolation[] = [];
    checkSummaryInventory(inventory, out);
    checkProjectInventory(inventory, out);
    checkSummaryEcho(inventory, out);
    checkProblemBridge(inventory, out, ctx.companyProblem);
    checkComplianceOverclaim(inventory, out);
    checkMetricStuffedBullets(inventory, out);
    const needsRepair = [
        ...inventory,
        ...violations.filter((v) => v.code === 'unbridged_transferable_claim'),
    ];
    if (needsRepair.length > 0) {
        violations.push(...inventory);
        out = await rewriteResume(out, needsRepair, ctx);
        // Deterministic passes are idempotent — re-assert after the repair.
        out = enforceProhibitedClaims(out).resume;
        out = enforceCertYears(out, ctx.verifiedCertifications ?? []).resume;
        out = enforceScopedClaims(out).resume;
        const residual: ResumeViolation[] = [];
        checkSummaryInventory(residual, out);
        checkProjectInventory(residual, out);
        checkSummaryEcho(residual, out);
        checkProblemBridge(residual, out, ctx.companyProblem);
        checkComplianceOverclaim(residual, out);
        checkMetricStuffedBullets(residual, out);
        if (residual.length > 0) {
            violations.push({ code: 'content_revalidation_residual', detail: `After one bounded repair, still violating: ${residual.map((r) => r.code).join(', ')}.` });
        }
    }
    return { resume: stripEmDashes(out), violations };
}

/** Validate → rewrite on violation → deterministic scoped-claim + section passes → return. Never throws. */
export async function guardResume(
    resume: StructuredResumeData,
    ctx: ResumeGuardCtx,
): Promise<{ resume: StructuredResumeData; violations: ResumeViolation[] }> {
    const violations = validateResume(resume, ctx);
    const rewritten = violations.length === 0 ? resume : await rewriteResume(resume, violations, ctx);
    const scoped = enforceScopedClaims(rewritten);
    violations.push(...scoped.violations);
    const sectioned = dropKeyAchievementsSection(scoped.resume);
    violations.push(...sectioned.violations);
    return { resume: stripEmDashes(sectioned.resume), violations };
}
