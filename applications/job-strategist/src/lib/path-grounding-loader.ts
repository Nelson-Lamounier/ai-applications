/**
 * @format
 * Authoritative ingested-path loader for the path-grounding verifier.
 *
 * Returns the set of distinct `file_path` values the user actually has in
 * `document_embeddings` — the ground truth a Strategist file-path citation
 * must match. Kept separate from the pure `path-grounding.ts` so the matching
 * logic stays I/O-free and unit-testable.
 */
import type { Pool } from 'pg';

/**
 * Load the distinct ingested file paths for a user across all their repos.
 *
 * RLS note: this Job connects as the pipeline role; the query is explicitly
 * user-scoped via `WHERE user_id = $1` to match the rest of run-pipeline's
 * data access. Capped to bound memory on very large portfolios — the cap is
 * far above any realistic single-user file count and only the SET membership
 * matters, not order.
 */
export async function loadIngestedPaths(
    pool: Pool,
    userId: string,
    limit = 20_000,
): Promise<Set<string>> {
    const r = await pool.query<{ file_path: string }>(
        `SELECT DISTINCT file_path
           FROM document_embeddings
          WHERE user_id = $1
          LIMIT $2`,
        [userId, limit],
    );
    return new Set(r.rows.map((row) => row.file_path).filter(Boolean));
}
