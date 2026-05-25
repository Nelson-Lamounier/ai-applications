/** @format */
import type { Pool } from 'pg';
import type { ImportRunCounts } from '../types/ontology-import.js';

export class OntologyImportRunRepository {
    constructor(private readonly pool: Pool) {}

    async begin(source: string, triggeredBy: 'cronjob' | 'manual' | 'backfill'): Promise<string> {
        const { rows } = await this.pool.query<{ id: string }>(
            `INSERT INTO ontology_import_runs (source, triggered_by, status, started_at)
             VALUES ($1, $2, $3, now()) RETURNING id`,
            [source, triggeredBy, 'running'],
        );
        return rows[0].id;
    }

    async finish(
        id: string,
        status: 'success' | 'failed' | 'partial',
        c: ImportRunCounts,
        extra?: { llmBatchId?: string; errorSummary?: string },
    ): Promise<void> {
        await this.pool.query(
            `UPDATE ontology_import_runs SET
                status = $2, completed_at = now(),
                entries_fetched = $3, entries_inserted = $4, entries_updated = $5,
                entries_deactivated = $6, alias_merges = $7, unresolved_count = $8,
                review_queue_added = $9, llm_batch_id = COALESCE($10, llm_batch_id),
                error_summary = $11
             WHERE id = $1`,
            [
                id, status, c.entriesFetched, c.entriesInserted, c.entriesUpdated,
                c.entriesDeactivated, c.aliasMerges, c.unresolvedCount, c.reviewQueueAdded,
                extra?.llmBatchId ?? null, extra?.errorSummary ?? null,
            ],
        );
    }

    /** Runs awaiting LLM batch completion. */
    async findPendingBatches(): Promise<Array<{ id: string; source: string; llmBatchId: string }>> {
        const { rows } = await this.pool.query<{ id: string; source: string; llm_batch_id: string }>(
            `SELECT id, source, llm_batch_id FROM ontology_import_runs WHERE status = 'partial' AND llm_batch_id IS NOT NULL`,
        );
        return rows.map((r) => ({ id: r.id, source: r.source, llmBatchId: r.llm_batch_id }));
    }
}
