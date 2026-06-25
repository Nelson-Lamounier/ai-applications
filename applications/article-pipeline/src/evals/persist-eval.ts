/**
 * @format
 * Persist the article-pipeline live eval to the shared rag_eval_runs /
 * rag_eval_results tables (migration 069) so Grafana can chart each phase's
 * quality over time alongside the RAG eval. Fleet-level data — no user_id, no RLS.
 *
 * The schema is RAG-shaped but `tool` is free text and indexed (tool, run_at),
 * so each phase lands as its own series:
 *   - tool='article-research' — mean_recall_at_k = mean repo-recall on positives;
 *                               mean_relevance_negative = leakage (lower better).
 *   - tool='article-writer'   — mean_recall_at_k = clean-brief rate.
 *   - tool='article-qa'       — mean_recall_at_k = judge accuracy.
 * Per-item rows land in rag_eval_results (recall_at_k = the item's 0/1 or ratio).
 *
 * The mapping (toEvalRunRows) is pure and unit-tested; persistEvalRuns is the
 * thin INSERT. Both are best-effort at the call site — a charting write must
 * never fail the eval Job.
 */
import type { Pool } from 'pg';

import type { ArticleEvalReport } from './article-eval-score.js';
import type { WriterCheckReport } from './article-quality-checks.js';
import type { QaEvalReport } from './qa-eval-score.js';

export interface EvalResultRow {
    readonly queryId: string;
    readonly kind: 'positive' | 'negative';
    readonly recallAtK: number;
    readonly retrievedCount: number;
}

export interface EvalRunRow {
    readonly tool: string;
    readonly queryCount: number;
    readonly positiveCount: number;
    readonly negativeCount: number;
    readonly meanRecallAtK: number;
    readonly meanRelevancePositive: number;
    readonly meanRelevanceNegative: number;
    readonly notes: string;
    readonly results: ReadonlyArray<EvalResultRow>;
}

/** Pure: map the three phase reports onto rag_eval_runs/-results row shapes. */
export function toEvalRunRows(
    research: ArticleEvalReport,
    writer: ReadonlyArray<WriterCheckReport>,
    qa: QaEvalReport,
    passes: { research: boolean; writer: boolean; qa: boolean },
): EvalRunRow[] {
    const researchRow: EvalRunRow = {
        tool:                  'article-research',
        queryCount:            research.queryCount,
        positiveCount:         research.positiveCount,
        negativeCount:         research.negativeCount,
        meanRecallAtK:         research.meanRecallPositive,
        meanRelevancePositive: research.meanRecallPositive,
        meanRelevanceNegative: research.meanRecallNegative,
        notes:                 `pass=${passes.research}`,
        results: research.perQuery.map((q) => ({
            queryId:        q.id,
            kind:           q.kind,
            recallAtK:      q.repoRecall,
            retrievedCount: q.retrievedCount,
        })),
    };

    const writerRate = writer.length === 0 ? 0 : writer.filter((r) => r.ok).length / writer.length;
    const writerRow: EvalRunRow = {
        tool:                  'article-writer',
        queryCount:            writer.length,
        positiveCount:         writer.length,
        negativeCount:         0,
        meanRecallAtK:         writerRate,
        meanRelevancePositive: writerRate,
        meanRelevanceNegative: 0,
        notes:                 `pass=${passes.writer}`,
        results: writer.map((r) => ({
            queryId:        r.id,
            kind:           'positive' as const,
            recallAtK:      r.ok ? 1 : 0,
            retrievedCount: r.passedCount,
        })),
    };

    const qaRow: EvalRunRow = {
        tool:                  'article-qa',
        queryCount:            qa.caseCount,
        // Defect cases are the "positives" (should flag); the clean control is the
        // "negative" (should NOT flag) — mirrors the RAG positive/negative split.
        positiveCount:         qa.perCase.filter((c) => c.expectedFlag !== 'none').length,
        negativeCount:         qa.perCase.filter((c) => c.expectedFlag === 'none').length,
        meanRecallAtK:         qa.accuracy,
        meanRelevancePositive: qa.accuracy,
        meanRelevanceNegative: 0,
        notes:                 `pass=${passes.qa}`,
        results: qa.perCase.map((c) => ({
            queryId:        c.id,
            kind:           (c.expectedFlag === 'none' ? 'negative' : 'positive') as 'positive' | 'negative',
            recallAtK:      c.detected ? 1 : 0,
            retrievedCount: 0,
        })),
    };

    return [researchRow, writerRow, qaRow];
}

/** Thin INSERT of the mapped rows. Each run + its results in one transaction. */
export async function persistEvalRuns(pool: Pool, rows: ReadonlyArray<EvalRunRow>): Promise<void> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        for (const row of rows) {
            const run = await client.query<{ id: string }>(
                `INSERT INTO rag_eval_runs
                   (tool, query_count, positive_count, negative_count,
                    mean_recall_at_k, mean_relevance_positive, mean_relevance_negative, notes)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
                [row.tool, row.queryCount, row.positiveCount, row.negativeCount,
                 row.meanRecallAtK, row.meanRelevancePositive, row.meanRelevanceNegative, row.notes],
            );
            const runId = run.rows[0]?.id;
            if (!runId) throw new Error('rag_eval_runs insert returned no id');
            for (const r of row.results) {
                await client.query(
                    `INSERT INTO rag_eval_results
                       (run_id, query_id, kind, recall_at_k, retrieved_count)
                     VALUES ($1, $2, $3, $4, $5)`,
                    [runId, r.queryId, r.kind, r.recallAtK, r.retrievedCount],
                );
            }
        }
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}
