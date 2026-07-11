/**
 * @format
 * Summary + positioning rules: inventory/echo checks, the problem bridge, and
 * the attribution family (employer vs solo project, JD-problem language
 * placement, job-describing sentences). Motivated by the Accenture DevOps run
 * whose summary welded "At AWS I triaged production failures; building Tucaken,
 * I eliminated…" (AWS role is customer support — everything after the semicolon
 * read as AWS platform work) and re-used the companyProblem's "cross-functional
 * teams … bottleneck" phrasing as the candidate's own identity claim.
 */
import type { StructuredResumeData } from '@bedrock/shared';
import type { ResumeViolation, ResumeGuardCtx } from './types.js';
import {
    SENTENCE_SPLIT, numbersIn, contentTokens, contentBigrams,
    nameVariants, escapeRe, anyVariantIn,
} from './text.js';

const GAP_PHRASE_RE = /falls?\s+short|do(?:es)?\s*not\s+yet\s+have/i;
const GAP_YEARS_RE = /\b\d{1,2}\s*years?\b[^.]{0,40}\b(?:short|threshold|bar|requirement|fall)/i;
export const namesGap = (text: string): boolean => GAP_PHRASE_RE.test(text) || GAP_YEARS_RE.test(text);

/**
 * Generic stop-words that appear in many identities and are not differentiating
 * (e.g. "engineer", "builds", "years", "with", "who").
 */
const GENERIC_TOKENS = new Set(['engineer', 'builds', 'build', 'years', 'with', 'from', 'that', 'this', 'have', 'been', 'into', 'your', 'their', 'where', 'what', 'will', 'more', 'over', 'about', 'some', 'when', 'than', 'like']);

/** Job-title nouns that must not appear in a positioning headline's lead segment. */
export const TITLE_NOUNS = new Set(['engineer', 'engineering', 'associate', 'analyst', 'manager', 'developer', 'specialist', 'lead', 'architect', 'consultant', 'administrator', 'coordinator', 'technician', 'officer', 'director', 'assistant', 'representative', 'agent', 'scientist']);

/** A "Selected work"/GitHub highlight must not sit under a support/customer/QA role. */
const SUPPORT_ROLE_RE = /support|customer|service|associate|quality assurance|\bqa\b|help\s?desk|technician/i;
const SELECTED_WORK_RE = /selected work|github\.com/i;

/**
 * Returns the distinctive lead tokens from the identity string — words that
 * identify the archetype cluster (e.g. "support", "production") — by taking
 * the first token that is not in GENERIC_TOKENS.
 */
export function leadClusterTokens(leadIdentity: string): string[] {
    const all = leadIdentity.toLowerCase().split(/[^a-z]+/).filter((t) => t.length > 3);
    return all.filter((t) => !GENERIC_TOKENS.has(t));
}

/** Returns the support/customer role title whose highlights hold a Selected-work/GitHub line, else null. */
export function findMisplacedSelectedWork(resume: StructuredResumeData): string | null {
    for (const e of resume.experience ?? []) {
        if (SUPPORT_ROLE_RE.test(e.title) && (e.highlights ?? []).some((h) => SELECTED_WORK_RE.test(h))) {
            return e.title;
        }
    }
    return null;
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
export function checkSummaryInventory(out: ResumeViolation[], resume: StructuredResumeData): void {
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
export function checkProjectInventory(out: ResumeViolation[], resume: StructuredResumeData): void {
    const bulletNums = numbersIn((resume.experience ?? []).flatMap((e) => e.highlights ?? []).join(' '));
    for (const p of resume.projects ?? []) {
        const shared = [...numbersIn(p.description ?? '')].filter((n) => bulletNums.has(n));
        if (shared.length > 1) {
            out.push({ code: 'project_restates_bullets', detail: `Project "${p.name}" repeats ${shared.length} numbers already used in experience bullets (${shared.join(', ')}) — open with the documented pitch, add one JD-relevant differentiator, one fresh metric.` });
        }
    }
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
    return (resume.summary ?? '').split(SENTENCE_SPLIT).filter((sentence) => {
        const tokens = contentTokens(sentence);
        if (tokens.length < 4) return false;
        const hits = tokens.filter((t) => bulletTokens.has(t)).length;
        return hits >= 4 && hits / tokens.length >= 0.6;
    });
}

export function checkSummaryEcho(out: ResumeViolation[], resume: StructuredResumeData): void {
    const echoes = summaryEchoSentences(resume);
    if (echoes.length > 0) {
        out.push({ code: 'summary_echoes_bullets', detail: `Summary sentence(s) topically restate experience bullets: "${echoes[0].slice(0, 120)}…" — the summary positions (problem bridge, distinctive angle); bullets prove.` });
    }
}

/** The summary must visibly bridge to the JD's company problem (>= 2 distinctive problem tokens present). */
export function checkProblemBridge(out: ResumeViolation[], resume: StructuredResumeData, companyProblem?: string): void {
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
 * Summary sentences that name a verified employer AND a project in the same
 * sentence — one predicate chain makes the reader attribute the project's
 * platform claims to the employer. Employer anchor and solo-project bridge
 * must be separate sentences.
 */
export function summaryConflationSentences(resume: StructuredResumeData, ctx: ResumeGuardCtx): string[] {
    const employerVariants = (ctx.verifiedEmployers ?? []).flatMap((e) => nameVariants(e.name));
    const projectVariants = (ctx.projectPitches ?? []).flatMap((p) => nameVariants(p.name));
    if (employerVariants.length === 0 || projectVariants.length === 0) return [];
    return (resume.summary ?? '').split(SENTENCE_SPLIT).filter(
        (s) => anyVariantIn(s, employerVariants) && anyVariantIn(s, projectVariants),
    );
}

/**
 * companyProblem phrases (bigrams) appearing in the summary's FIRST sentence —
 * the identity beat. JD-problem language in the identity claim reads as the
 * candidate's delivered track record ("so cross-functional teams ship
 * reliably"); problem vocabulary belongs in the attributed bridge sentence.
 */
export function identityProblemPhrases(resume: StructuredResumeData, companyProblem?: string): string[] {
    if (!companyProblem) return [];
    const first = (resume.summary ?? '').split(SENTENCE_SPLIT)[0] ?? '';
    const problemBigrams = contentBigrams(companyProblem);
    return [...contentBigrams(first)].filter((b) => problemBigrams.has(b));
}

/**
 * Job-describing phrases — BANNED in a summary. A summary describes the
 * candidate (what they bring), never the job (what the employer needs): the
 * reader already knows their own mission. This is the INVERSE of the original
 * bridge-attribution rule, which produced "This role exists to expand Mater
 * Private Network's IT capacity…" — an employer-named mission recitation
 * (run f133155f). Tailoring surfaces through which capabilities the summary
 * foregrounds, never through sentences about the employer.
 */
const JOB_DESCRIBING_RE = /\bthis role\b|\bthe role\b|\brole exists\b|\bthey need\b|\bis hiring\b|\btheir (?:team|teams|platform|engineers|mission)\b|\bthe problem:/i;

/** Summary sentences that describe the JOB rather than the candidate. */
export function jobDescribingSentences(resume: StructuredResumeData): string[] {
    return (resume.summary ?? '').split(SENTENCE_SPLIT).filter((s) => JOB_DESCRIBING_RE.test(s));
}

/**
 * Target-company name variants that are safe to flag: variants shared with a
 * verified employer stay legal (e.g. target Accenture while the career history
 * holds "Meta via Accenture" — the employer anchor may name it).
 */
function flaggableTargetVariants(ctx: ResumeGuardCtx): string[] {
    const target = ctx.targetCompany ? nameVariants(ctx.targetCompany) : [];
    if (target.length === 0) return [];
    const employerVariants = new Set((ctx.verifiedEmployers ?? []).flatMap((e) => nameVariants(e.name)));
    return target.filter((v) => !employerVariants.has(v));
}

/** Summary sentences naming the target company (single-use resume + recitation smell). */
export function targetCompanySentences(resume: StructuredResumeData, ctx: ResumeGuardCtx): string[] {
    const variants = flaggableTargetVariants(ctx);
    if (variants.length === 0) return [];
    return (resume.summary ?? '').split(SENTENCE_SPLIT).filter((s) => anyVariantIn(s, variants));
}

/**
 * Deterministic backstop: DELETE summary sentences that describe the job or
 * name the target company. Runs when the bounded repair leaves them behind —
 * same precedent as the cover letter's third-person sentence strip. A summary
 * must never ship describing the employer's mission.
 */
export function stripJobDescribingSentences(
    resume: StructuredResumeData,
    ctx: ResumeGuardCtx,
    onViolation?: (v: ResumeViolation) => void,
): StructuredResumeData {
    const variants = flaggableTargetVariants(ctx);
    const sentences = (resume.summary ?? '').split(SENTENCE_SPLIT);
    const kept = sentences.filter((s) => !JOB_DESCRIBING_RE.test(s) && !anyVariantIn(s, variants));
    if (kept.length === sentences.length) return resume;
    onViolation?.({ code: 'summary_job_sentence_stripped', detail: `Deterministically removed ${sentences.length - kept.length} summary sentence(s) describing the job / naming the target company after the bounded repair left them in.` });
    return { ...resume, summary: kept.join(' ').trim() };
}

/**
 * Deterministic backstop for identity-echo residuals: remove the clause
 * carrying a companyProblem bigram from the FIRST sentence (e.g. "…foundations
 * for cross-functional teams" -> "…foundations"). Falls back to deleting the
 * bigram words when no clause boundary wraps them.
 */
export function stripIdentityProblemClause(
    resume: StructuredResumeData,
    companyProblem: string | undefined,
    onViolation?: (v: ResumeViolation) => void,
): StructuredResumeData {
    const leaked = identityProblemPhrases(resume, companyProblem);
    if (leaked.length === 0) return resume;
    const sentences = (resume.summary ?? '').split(SENTENCE_SPLIT);
    let first = sentences[0] ?? '';
    for (const bigram of leaked) {
        const [a, b] = bigram.split(' ');
        const clause = new RegExp(String.raw`,?\s*(?:for|so that|so|enabling|supporting|helping|that)\s+[^,.]*${escapeRe(a)}[^,.]*${escapeRe(b)}[^,.]*`, 'i');
        if (clause.test(first)) {
            first = first.replace(clause, '');
        } else {
            first = first.replace(new RegExp(String.raw`${escapeRe(a)}[\s-]+${escapeRe(b)}`, 'i'), '');
        }
    }
    first = first.replaceAll(/\s{2,}/g, ' ').replaceAll(/\s+([,.])/g, '$1').replace(/,\s*\./, '.').trim();
    onViolation?.({ code: 'summary_identity_clause_stripped', detail: `Deterministically removed companyProblem phrasing (${leaked.join('; ')}) from the identity sentence after the bounded repair left it in.` });
    return { ...resume, summary: [first, ...sentences.slice(1)].join(' ').trim() };
}

/**
 * Employer alias the summary OPENS with, or ''. "AWS cloud and backend
 * engineer" written by someone employed at Amazon Web Services reads as a job
 * title held AT AWS (run 77e325ea) — a misread waiting to happen at reference
 * stage. Employer names may still appear mid-sentence as work context
 * ("three years inside AWS production operations").
 */
function summaryEmployerOpener(resume: StructuredResumeData, ctx: ResumeGuardCtx): string {
    const summary = (resume.summary ?? '').trim().toLowerCase();
    if (!summary) return '';
    for (const variant of (ctx.verifiedEmployers ?? []).flatMap((e) => nameVariants(e.name))) {
        if (variant && summary.startsWith(`${variant} `)) return variant;
    }
    return '';
}

/** All attribution checks — shared by the first guard pass and revalidation. */
export function checkSummaryAttribution(out: ResumeViolation[], resume: StructuredResumeData, ctx: ResumeGuardCtx): void {
    const employerOpener = summaryEmployerOpener(resume, ctx);
    if (employerOpener) {
        out.push({ code: 'summary_opens_with_employer', detail: `Summary opens with the employer name "${employerOpener}" and reads as a job title held at that employer — keep the identity differentiator's content but rephrase so it does not OPEN with an employer name (e.g. "Cloud engineer with three years inside AWS production operations", never "AWS cloud engineer").` });
    }
    const conflated = summaryConflationSentences(resume, ctx);
    if (conflated.length > 0) {
        out.push({ code: 'summary_employer_project_conflation', detail: `Summary sentence names an employer AND a project in one predicate chain: "${conflated[0].slice(0, 140)}" — split into separate sentences; the employer sentence carries only that employer's verified facts; the project sentence opens with the solo framing.` });
    }
    const leaked = identityProblemPhrases(resume, ctx.companyProblem);
    if (leaked.length > 0) {
        out.push({ code: 'summary_identity_echoes_problem', detail: `Identity sentence re-uses the JD companyProblem's phrasing (${leaked.slice(0, 3).join('; ')}) as the candidate's own track record — problem language belongs in the attributed bridge sentence.` });
    }
    const jobSentences = jobDescribingSentences(resume);
    if (jobSentences.length > 0) {
        out.push({ code: 'summary_describes_job', detail: `Summary sentence describes the JOB, not the candidate: "${jobSentences[0].slice(0, 140)}" — a summary states what the candidate brings; rewrite in candidate voice (the capabilities that meet this problem class) and delete role/mission recitation.` });
    }
    const namesTarget = targetCompanySentences(resume, ctx);
    if (namesTarget.length > 0) {
        out.push({ code: 'summary_names_target_company', detail: `Summary names the target company ("${namesTarget[0].slice(0, 140)}") — a summary naming the employer is single-use and reads as mission recitation; remove the name, keep the capability.` });
    }
}
