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
 * Persist the rendered article markdown back to platform RDS.
 *
 * Sets status='review' — admin-api owns the eventual transition to 'published'.
 */
export async function persistArticle(
    pool: Pool,
    slug: string,
    contentMd: string,
): Promise<void> {
    await pool.query(
        `UPDATE articles SET content_md = $2, status = 'review', updated_at = NOW() WHERE slug = $1`,
        [slug, contentMd],
    );
}
