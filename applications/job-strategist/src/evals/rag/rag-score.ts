/** @format */
/**
 * Pure scoring for the RAG retrieval eval. No I/O — the live runner
 * (run-rag-eval.ts) supplies real retrieved contexts + judge scores; this module
 * computes recall@k, builds the context-relevance judge prompt/tool, and
 * aggregates. Tool-agnostic: the same per-query records can be emitted as JSONL
 * for DeepEval / RAGAS / Bedrock-Evaluations BYOI.
 */

export interface RetrievedContext {
    /** "owner/repo/path" */
    readonly source: string;
    readonly cosine: number;
    /** First ~N chars of the chunk — what the judge reads. */
    readonly snippet: string;
}

export interface GoldenQuery {
    readonly id: string;
    readonly query: string;
    readonly expectedRepos?: string[];
    readonly expectedFiles?: string[];
    /** 'negative' queries SHOULD retrieve low-relevance context (honest gap). */
    readonly kind: 'positive' | 'negative';
}

export interface QueryEvalResult {
    readonly id: string;
    readonly kind: 'positive' | 'negative';
    /** null when the golden has no expected sources (negatives). */
    readonly recallAtK: number | null;
    /** Mean context-relevance over retrieved chunks (judge, 0..1). */
    readonly contextRelevance: number;
    readonly retrievedCount: number;
    readonly maxCosine: number;
}

export interface RagEvalReport {
    readonly queryCount: number;
    readonly positiveCount: number;
    readonly negativeCount: number;
    /** Mean recall@k over positives that declared expected sources. */
    readonly meanRecallAtK: number | null;
    /** Higher = better: positives surface relevant context. */
    readonly meanRelevancePositive: number;
    /** Lower = better: negatives should NOT surface relevant context (leakage). */
    readonly meanRelevanceNegative: number;
    readonly meanMaxCosine: number;
    readonly perQuery: ReadonlyArray<QueryEvalResult>;
}

/** Fraction of expected sources present in the retrieved top-k (null if none expected). */
export function recallAtK(retrieved: ReadonlyArray<RetrievedContext>, golden: GoldenQuery, k: number): number | null {
    const expected = [...(golden.expectedRepos ?? []), ...(golden.expectedFiles ?? [])].map(s => s.toLowerCase());
    if (expected.length === 0) return null;
    const sources = retrieved.slice(0, k).map(c => c.source.toLowerCase());
    const found = expected.filter(e => sources.some(s => s.includes(e)));
    return found.length / expected.length;
}

const mean = (xs: ReadonlyArray<number>): number =>
    xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

/** Average of the (0..1) per-context relevance scores; 0 when nothing retrieved. */
export function meanRelevance(scores: ReadonlyArray<number>): number {
    return mean(scores);
}

export function aggregate(results: ReadonlyArray<QueryEvalResult>): RagEvalReport {
    const positives = results.filter(r => r.kind === 'positive');
    const negatives = results.filter(r => r.kind === 'negative');
    const recalls = results.map(r => r.recallAtK).filter((r): r is number => r !== null);
    return {
        queryCount:    results.length,
        positiveCount: positives.length,
        negativeCount: negatives.length,
        meanRecallAtK: recalls.length > 0 ? mean(recalls) : null,
        meanRelevancePositive: mean(positives.map(r => r.contextRelevance)),
        meanRelevanceNegative: mean(negatives.map(r => r.contextRelevance)),
        meanMaxCosine: mean(results.map(r => r.maxCosine)),
        perQuery: results,
    };
}

// ── Context-relevance LLM judge ─────────────────────────────────────────────────

export const RELEVANCE_JUDGE_TOOL = {
    name: 'emit_relevance_scores',
    description: 'Score each retrieved context 0..1 for relevance to the query.',
    input_schema: {
        type: 'object',
        properties: {
            scores: {
                type: 'array',
                items: { type: 'number' },
                description: 'One 0..1 relevance score per context, in the SAME order as presented.',
            },
        },
        required: ['scores'],
        additionalProperties: false,
    },
} as const;

/** Judge prompt: rate each retrieved chunk's relevance to the query (RAG context-relevance). */
export function buildRelevanceJudgePrompt(query: string, contexts: ReadonlyArray<RetrievedContext>): string {
    const blocks = contexts.map((c, i) =>
        `[${i}] source: ${c.source}\n${c.snippet}`,
    );
    return [
        'You are scoring a RAG retriever. For the QUERY below, rate how relevant',
        'EACH retrieved context is to answering it, as a number from 0 (irrelevant)',
        'to 1 (directly relevant). Judge only the text shown — do not infer from the',
        'file path alone. Return one score per context, in order, via the',
        'emit_relevance_scores tool.',
        '',
        `QUERY: ${query}`,
        '',
        'CONTEXTS:',
        ...blocks,
    ].join('\n');
}

/** Defensive parse of the judge tool input into a per-context score array of fixed length. */
export function parseRelevanceScores(raw: unknown, count: number): number[] {
    const scores = (raw as { scores?: unknown })?.scores;
    const out: number[] = [];
    for (let i = 0; i < count; i++) {
        const v = Array.isArray(scores) ? scores[i] : undefined;
        const n = typeof v === 'number' && Number.isFinite(v) ? v : 0;
        out.push(Math.max(0, Math.min(1, n)));
    }
    return out;
}

/** Markdown summary for the console / CI log. */
export function formatReport(report: RagEvalReport): string {
    const pct = (n: number | null): string => (n === null ? 'n/a' : `${(n * 100).toFixed(0)}%`);
    const rows = report.perQuery.map(r =>
        `| ${r.id} | ${r.kind} | ${pct(r.recallAtK)} | ${r.contextRelevance.toFixed(2)} | ${r.maxCosine.toFixed(3)} |`,
    );
    return [
        `RAG retrieval eval — ${report.queryCount} queries (${report.positiveCount} pos / ${report.negativeCount} neg)`,
        `mean recall@k: ${pct(report.meanRecallAtK)} · relevance pos↑ ${report.meanRelevancePositive.toFixed(2)} · relevance neg↓ ${report.meanRelevanceNegative.toFixed(2)} · mean maxCosine ${report.meanMaxCosine.toFixed(3)}`,
        '',
        '| query | kind | recall@k | relevance | maxCosine |',
        '| --- | --- | --- | --- | --- |',
        ...rows,
    ].join('\n');
}
