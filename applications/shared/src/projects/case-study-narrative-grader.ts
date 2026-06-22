/**
 * @format
 * Deterministic graders for the case-study NARRATIVE contract (CLAUDE.md §5).
 *
 * String/array checks only — no LLM call — so they run in CI on every prompt
 * change AND can grade a live agent run. They encode the refined prompt's
 * promises: the engineering rows are led by the work the commits/PRs show
 * (workLeadsNarrative); tech is a grounding aid, never the spine
 * (techNotSpine); and the voice is confident, not hedged (confidentVoice).
 *
 * The subjective "reads as one combined story" dimension is graded separately
 * by `judgeCombinedOverview` (an injectable LLM judge), kept out of the
 * deterministic CI path.
 */
import { TECH_TOKENS, words, firstParagraph } from './case-study-product-grader.js';
import type { CaseStudy, SourceSignal } from './case-study-types.js';

export interface NarrativeGradeInput {
    readonly caseStudy: CaseStudy;
}
export interface NarrativeGradeResult {
    readonly grader: string;
    readonly pass: boolean;
    readonly score: number; // 0..1
    readonly failures: readonly string[];
}
export interface NarrativeGradeReport {
    readonly pass: boolean;
    readonly results: readonly NarrativeGradeResult[];
}

const mk = (grader: string, failures: string[], score?: number): NarrativeGradeResult => ({
    grader,
    pass: failures.length === 0,
    score: score ?? (failures.length === 0 ? 1 : 0),
    failures,
});

const hasWork = (sig: SourceSignal): boolean => sig.commits.length > 0 || sig.pulls.length > 0;

/** Every engineering row (highlight/challenge/decision) is led by commit/PR work. */
export function gradeWorkLeadsNarrative(input: NarrativeGradeInput): NarrativeGradeResult {
    const cs = input.caseStudy;
    const failures: string[] = [];
    cs.highlights.forEach((h, i) => { if (!hasWork(h.sourceSignals)) failures.push(`highlight[${i}] "${h.title}" cites no commit or PR`); });
    cs.challenges.forEach((c, i) => { if (!hasWork(c.sourceSignals)) failures.push(`challenge[${i}] "${c.problem.slice(0, 40)}" cites no commit or PR`); });
    cs.decisions.forEach((d, i) => { if (!hasWork(d.sourceSignals)) failures.push(`decision[${i}] "${d.title}" cites no commit or PR`); });
    return mk('workLeadsNarrative', failures);
}

/** Tech must not be the organising spine: pitch + highlight titles aren't tech-dominated. */
function techDominated(text: string): boolean {
    const ws = words(text).filter((w) => w.length > 2);
    if (ws.length === 0) return false;
    const tech = ws.filter((w) => TECH_TOKENS.has(w)).length;
    return tech / ws.length > 0.5;
}
export function gradeTechNotSpine(input: NarrativeGradeInput): NarrativeGradeResult {
    const cs = input.caseStudy;
    const failures: string[] = [];
    if (techDominated(firstParagraph(cs.pitch))) failures.push('pitch first paragraph is tech-dominated — organise it around the work, not the stack');
    cs.highlights.forEach((h, i) => { if (techDominated(h.title)) failures.push(`highlight[${i}] title is tech-dominated — lead with the work, not the tech`); });
    return mk('techNotSpine', failures);
}

/** Confident voice: no hedge tokens in pitch / highlight descriptions / decision text. */
const HEDGES: ReadonlyArray<RegExp> = [
    /\bclaimed\b/i, /\bappears to\b/i, /\battempted to\b/i, /\bwe built\b/i, /\bwe designed\b/i,
];
function hedgesIn(text: string): string[] {
    return HEDGES.filter((re) => re.test(text)).map((re) => re.source);
}
export function gradeConfidentVoice(input: NarrativeGradeInput): NarrativeGradeResult {
    const cs = input.caseStudy;
    const failures: string[] = [];
    const corpus = [cs.pitch, ...cs.highlights.map((h) => h.description), ...cs.decisions.map((d) => `${d.context} ${d.decision} ${d.consequences}`)];
    corpus.forEach((t) => { for (const h of hedgesIn(t)) failures.push(`hedged phrasing "${h}" — state evidenced work plainly`); });
    return mk('confidentVoice', failures);
}

const NARRATIVE_GRADERS: ReadonlyArray<(i: NarrativeGradeInput) => NarrativeGradeResult> = [
    gradeWorkLeadsNarrative,
    gradeTechNotSpine,
    gradeConfidentVoice,
];

export function runNarrativeGraders(input: NarrativeGradeInput): NarrativeGradeReport {
    const results = NARRATIVE_GRADERS.map((g) => g(input));
    return { pass: results.every((r) => r.pass), results };
}
