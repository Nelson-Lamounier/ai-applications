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

/** Queryable article metadata written to the articles columns the portfolio renders from. */
export interface PersistArticleMetadata {
    /** SEO title from the Writer (frontmatter `title`). Replaces the placeholder slug-as-title. */
    readonly title: string;
    /** 150–160 char meta description from the Writer (frontmatter `description`). */
    readonly excerpt: string;
    /** Canonical tag vocabulary the Writer selected. */
    readonly tags: readonly string[];
}

/**
 * Persist the rendered article markdown back to platform RDS.
 *
 * Sets status='review' — admin-api owns the eventual transition to 'published'.
 * Stamps ai_model with the foundation model that wrote the content so a
 * published article's provenance (which model generated it) is always queryable
 * from the row itself, never inferred from deploy timelines.
 *
 * Also writes the Writer's `title`, `excerpt`, and `tags` into their own columns.
 * The public-api (portfolio) and admin dashboard render from these columns, not
 * from the MDX frontmatter — without this, every generated article surfaced with
 * the raw placeholder slug as its title and no excerpt or tags.
 */
export async function persistArticle(
    pool: Pool,
    slug: string,
    contentMd: string,
    aiModel: string,
    metadata: PersistArticleMetadata,
): Promise<void> {
    const result = await pool.query(
        `UPDATE articles
            SET content_md = $2,
                ai_model   = $3,
                title      = $4,
                excerpt    = $5,
                tags       = $6,
                status     = 'review',
                updated_at = NOW()
          WHERE slug = $1`,
        [slug, contentMd, aiModel, metadata.title, metadata.excerpt, [...metadata.tags]],
    );
    if (result.rowCount === 0) {
        throw new Error(`persistArticle: no articles row found for slug '${slug}' — ensure article placeholder is created before dispatching the K8s Job`);
    }
}
