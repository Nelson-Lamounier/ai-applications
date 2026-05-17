/**
 * @format
 * Helpers for the platform RDS pipeline_runs status table and
 * the final write-back to the platform RDS articles table.
 */
import type { Pool } from 'pg';

/**
 * Update a pipeline_runs row's status (and optional error message).
 * Status values flow: queued → researching → writing → qa → complete (or failed).
 */
export async function updatePipelineRun(
    pool: Pool,
    id: string,
    status: string,
    errorMessage?: string,
): Promise<void> {
    await pool.query(
        `UPDATE pipeline_runs SET status = $2, error_message = $3, updated_at = NOW() WHERE id = $1`,
        [id, status, errorMessage ?? null],
    );
}

/**
 * Update the metadata JSON column on a pipeline_runs row.
 *
 * Used to attach run-level metadata (e.g. grounding result) to the pipeline_runs
 * record after the pipeline completes. The metadata column is an unconstrained
 * JSONB blob — no migration required to add new keys.
 */
export async function updatePipelineRunMetadata(
    pool: Pool,
    id: string,
    metadata: Record<string, unknown>,
): Promise<void> {
    await pool.query(
        `UPDATE pipeline_runs SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb, updated_at = NOW() WHERE id = $1`,
        [id, JSON.stringify(metadata)],
    );
}

/**
 * Persist the rendered article markdown back to platform RDS.
 *
 * Sets status='review' — admin-api owns the eventual transition to 'published'.
 */
export async function persistArticle(
    pool: Pool,
    slug: string,
    contentMd: string,
): Promise<void> {
    const result = await pool.query(
        `UPDATE articles SET content_md = $2, status = 'review', updated_at = NOW() WHERE slug = $1`,
        [slug, contentMd],
    );
    if (result.rowCount === 0) {
        throw new Error(`persistArticle: no articles row found for slug '${slug}' — ensure article placeholder is created before dispatching the K8s Job`);
    }
}
