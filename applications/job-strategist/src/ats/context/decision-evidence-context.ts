/**
 * @format
 * Decision/Operational Evidence Context Builder — Task 2.
 *
 * Runs ONE supplementary, docType-scoped retrieval (the caller supplies the
 * `retrieve` closure, same shape as `buildOperationsRetrieve`) and formats the
 * results into a `## Design & Operational Evidence` block for the research
 * agent — additive to (never replacing) the main filter-then-rank KB context.
 *
 * Fail-open: an empty result set or ANY throw from `retrieve` yields ''. The
 * block never pushes a section when there is nothing to say.
 *
 * Injection-surface discipline: items are the SAME annotated
 * `[Source: ..., Cosine: ..., Rerank: ...]\n<text>` strings `querySingleRds`
 * already returns for the main evidence — no new untrusted field is read or
 * rendered.
 */
import type { JdSignal } from '@bedrock/shared';
import type { EvidenceAngle } from './evidence-doctype-select.js';

const DEFAULT_K = 6;
const CONCEPT_CAP = 6;

type JdQuerySignal = Pick<JdSignal, 'targetRole' | 'concepts'>;

/** `(query, k) => annotated evidence strings` — caller-supplied so this module
 *  stays pure and testable (mirrors `buildOperationsRetrieve`'s contract). */
export type DecisionEvidenceRetrieve = (query: string, k: number) => Promise<readonly string[]>;

function resolveK(): number {
    const raw = process.env['DOCTYPE_EVIDENCE_K'];
    const parsed = raw !== undefined ? Number(raw) : Number.NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_K;
}

/** Compact NL query phrase: target role + up to the first 6 JD concepts. */
function buildQuery(jd: JdQuerySignal): string {
    const concepts = jd.concepts.slice(0, CONCEPT_CAP).join(', ');
    return concepts.length > 0 ? `${jd.targetRole} — ${concepts}` : jd.targetRole;
}

const ARCHITECTURE_SENTENCE = "Architecture-decision records (ADRs) evidencing the candidate's design reasoning:";
const OPERATIONS_SENTENCE = 'Runbooks and troubleshooting guides evidencing operational ownership:';
const BOTH_SENTENCE =
    "Architecture-decision records (ADRs) evidencing the candidate's design reasoning, " +
    'and runbooks and troubleshooting guides evidencing operational ownership:';

function intentSentence(angle: EvidenceAngle): string {
    if (angle === 'both') return BOTH_SENTENCE;
    if (angle === 'operations') return OPERATIONS_SENTENCE;
    return ARCHITECTURE_SENTENCE;
}

/** One raw `querySingleRds`-annotated string -> one single-line bullet
 *  (internal newlines collapsed so the block stays scannable). */
function formatItem(raw: string): string {
    return `- ${raw.replace(/\s+/g, ' ').trim()}`;
}

/**
 * Build the supplementary "Design & Operational Evidence" block from a
 * docType-scoped retrieval pass.
 *
 * @param retrieve - Caller-supplied retrieval closure (query, k) -> evidence strings
 * @param jd - JD signal (targetRole + concepts) used to build the query
 * @param docTypes - The docType gate to apply (from `deriveEvidenceDocTypes`); empty ⇒ no pass
 * @param angle - The angle driving the intent sentence
 * @returns Formatted block, or '' on no docTypes / no results / any failure
 */
export async function buildDecisionEvidenceContext(
    retrieve: DecisionEvidenceRetrieve,
    jd: JdQuerySignal,
    docTypes: readonly string[],
    angle: EvidenceAngle,
): Promise<string> {
    if (docTypes.length === 0 || angle === null) return '';

    const k = resolveK();
    try {
        const results = await retrieve(buildQuery(jd), k);
        if (results.length === 0) return '';

        const items = results.slice(0, k).map(formatItem);
        return ['## Design & Operational Evidence', intentSentence(angle), '', ...items].join('\n');
    } catch {
        return '';
    }
}
