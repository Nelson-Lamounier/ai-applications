/**
 * @format
 * Deterministic graders for the case-study NARRATIVE contract (CLAUDE.md §5).
 * Also exports an injectable combined-overview LLM judge (`judgeCombinedOverview`)
 * and its real Bedrock implementation (`bedrockCombinedOverviewJudge`).
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
import { runAgent, parseJsonResponse } from '../agent-runner.js';
import type { BasePipelineContext } from '../base-agent.js';
import type { AgentConfig } from '../types.js';
import { TECH_TOKENS, words } from './case-study-product-grader.js';
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

const ROLL_CALL_MIN = 3; // a 5-second highlight title naming ≥3 technologies reads as a stack list

const firstSentence = (s: string): string => (s.split(/[.!?\n]/)[0] ?? s).trim();
const countTechTokens = (text: string): number => words(text).filter((w) => TECH_TOKENS.has(w)).length;
/** First alphanumeric/hyphen token of a title, lowercased (e.g. "tucaken-infra"). */
const leadToken = (title: string): string => /[a-z0-9-]+/.exec(title.toLowerCase())?.[0] ?? '';

/** Short names (owner/NAME → name) of every repo the case study cites in its evidence. */
function citedRepoShortNames(cs: CaseStudy): Set<string> {
    const names = new Set<string>();
    const rows: ReadonlyArray<{ sourceSignals: SourceSignal }> = [
        ...cs.highlights, ...cs.challenges, ...cs.decisions, ...cs.stack,
    ];
    for (const r of rows) {
        const s = r.sourceSignals;
        for (const full of [...s.commits.map((c) => c.repoFullName), ...s.pulls.map((p) => p.repoFullName), ...s.files.map((f) => f.repoFullName)]) {
            const short = full.split('/').pop()?.toLowerCase();
            if (short) names.add(short);
        }
    }
    return names;
}

/** Why a highlight title reads as tech-led (tech-dominated / repo-led / stack roll-call), or null. */
function titleSpineFailure(title: string, index: number, repos: ReadonlySet<string>): string | null {
    if (techDominated(title)) return `highlight[${index}] title is tech-dominated — lead with the work, not the tech`;
    if (repos.has(leadToken(title))) return `highlight[${index}] title leads with the repo name "${leadToken(title)}" — lead with the work; name the repo as supporting detail`;
    const n = countTechTokens(title);
    if (n >= ROLL_CALL_MIN) return `highlight[${index}] title is a stack roll-call (${n} technologies) — lead with the work/outcome, not a tech list`;
    return null;
}

export function gradeTechNotSpine(input: NarrativeGradeInput): NarrativeGradeResult {
    const cs = input.caseStudy;
    const failures: string[] = [];
    // Whole pitch: NO paragraph may open tech-dominated (extends the para-1-only check).
    cs.pitch.split(/\n\s*\n/).forEach((para, i) => {
        if (techDominated(firstSentence(para))) failures.push(`pitch paragraph ${i + 1} opens tech-dominated — lead it with the work, not the stack`);
    });
    const repos = citedRepoShortNames(cs);
    cs.highlights.forEach((h, i) => { const f = titleSpineFailure(h.title, i, repos); if (f) failures.push(f); });
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
    const corpus = [cs.pitch, ...cs.highlights.map((h) => h.description), ...cs.challenges.map((c) => `${c.problem} ${c.solution}`), ...cs.decisions.map((d) => `${d.context} ${d.decision} ${d.consequences}`)];
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

// =============================================================================
// COMBINED-OVERVIEW LLM JUDGE
// =============================================================================

/** Injectable judge interface — swap for a mock in tests or the real Bedrock impl in prod. */
export interface CombinedOverviewJudge {
    invoke(args: { pitch: string }): Promise<{ score: number; reasoning: string }>;
}

/** Grade the subjective "one combined story, not per-repo fragments" dimension. */
export async function judgeCombinedOverview(
    caseStudy: CaseStudy,
    judge: CombinedOverviewJudge,
    threshold = 0.7,
): Promise<NarrativeGradeResult> {
    const { score, reasoning } = await judge.invoke({ pitch: caseStudy.pitch });
    const failures =
        score >= threshold
            ? []
            : [`pitch reads as per-repo fragments (judge ${score.toFixed(2)} < ${threshold}): ${reasoning}`];
    return { grader: 'combinedOverview', pass: failures.length === 0, score, failures };
}

// ---------------------------------------------------------------------------
// Real Bedrock judge (behind CASE_STUDY_EVAL_JUDGE=1 in the E2E script)
// ---------------------------------------------------------------------------

const JUDGE_MODEL = process.env.CASE_STUDY_MODEL ?? 'eu.anthropic.claude-sonnet-4-6';
const JUDGE_TOOL = {
    name: 'emit_overview_score',
    description: 'Score whether the pitch reads as one combined product story.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            score:     { type: 'number', minimum: 0, maximum: 1 },
            reasoning: { type: 'string', minLength: 1, maxLength: 500 },
        },
        required: ['score', 'reasoning'],
        additionalProperties: false,
    },
};
const JUDGE_PROMPT =
    'You grade portfolio case-study pitches. Score 0..1 on TWO things together: (1) the pitch reads ' +
    'as ONE coherent product story across all repositories, not a list of per-repo fragments; and ' +
    '(2) technology is supporting detail, not the spine — no paragraph is organised around one ' +
    "repo's infrastructure or a roll-call of technologies. 1 = one combined overview that leads with " +
    'what the product is and does, with tech mentioned only in service of the work; 0 = disjoint ' +
    'per-repo, tech-led description. Penalise a paragraph that opens with infrastructure or a stack ' +
    'list. Emit the emit_overview_score tool.';

export const bedrockCombinedOverviewJudge: CombinedOverviewJudge = {
    async invoke({ pitch }) {
        const config: AgentConfig = {
            agentName:      'case-study-overview-judge',
            modelId:        process.env.INFERENCE_PROFILE_ARN ?? JUDGE_MODEL,
            maxTokens:      512,
            thinkingBudget: 0,
            systemPrompt:   [{ text: JUDGE_PROMPT }],
            pipeline:       'case-study-overview-judge',
            promptId:       'case-study-overview-judge-v1',
            tool:           JUDGE_TOOL,
        };
        const pipelineContext: BasePipelineContext = {
            pipelineId:        'eval-overview-judge',
            environment:       process.env.NODE_ENV ?? 'development',
            cumulativeTokens:  { input: 0, output: 0, thinking: 0 },
            cumulativeCostUsd: 0,
        };
        const res = await runAgent<{ score: number; reasoning: string }>({
            config,
            userMessage: `<pitch>\n${pitch}\n</pitch>\n\nEmit the emit_overview_score tool now.`,
            pipelineContext,
            parseResponse: (text) =>
                parseJsonResponse<{ score: number; reasoning: string }>(text, 'case-study-overview-judge'),
        });
        return res.data;
    },
};
