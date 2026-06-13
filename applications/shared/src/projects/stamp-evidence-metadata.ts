/**
 * @format
 * Apply the evidence-metadata stamp (verified-authorship + tech signals) onto a
 * user's document_embeddings.metadata, so filter-then-rank retrieval can gate
 * fork/low-trust evidence and pre-filter by tech without a join.
 * See docs/retrieval-filter-then-rank-spec.md (Increment 1).
 *
 * Reads only already-populated tables (repository_profiles, oauth_connections,
 * repo_commits, technology_evidence, document_embeddings) — so it back-fills the
 * existing corpus and re-runs idempotently each sync. Fail-open: any error is
 * logged by the caller; a missing source degrades to a conservative stamp.
 */

import type { Pool } from 'pg';
import { buildEvidenceStamp, type RepoSignals } from './evidence-metadata-stamp.js';

const CODE_LAYERS = ['syft', 'treesitter', 'iac', 'dockerfile'];

/** owner/repo → owner. */
function ownerOf(repoFullName: string): string {
    return repoFullName.split('/')[0] ?? '';
}

/**
 * Stamp every chunk of every repo the user has ingested. Returns the number of
 * repos stamped. One UPDATE per repo (its whole chunk set); the stamp keys are
 * merged into existing metadata (`||`), never replacing it.
 */
export async function stampUserEvidenceMetadata(pool: Pool, userId: string, onlyRepo?: string): Promise<number> {
    const login = await githubLogin(pool, userId);
    const allRepos = await distinctRepos(pool, userId);
    const repos = onlyRepo ? allRepos.filter((r) => r === onlyRepo) : allRepos;
    if (repos.length === 0) return 0;

    const profiles = await profileMap(pool, userId);
    const authored = await authoredRepoSet(pool, userId, login);
    const techByRepo = await techStackMap(pool, userId);

    let stamped = 0;
    for (const repo of repos) {
        const profile = profiles.get(repo);
        const signals: RepoSignals = {
            repoFullName: repo,
            classification: profile?.classification ?? null,
            qualityScore: profile?.qualityScore ?? null,
            ownerIsUser: login.length > 0 && ownerOf(repo).toLowerCase() === login.toLowerCase(),
            userAuthored: authored.has(repo),
            techStack: techByRepo.get(repo) ?? [],
            domain: null,
        };
        const stamp = buildEvidenceStamp(signals);
        await pool.query(
            `UPDATE document_embeddings
                SET metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb
              WHERE user_id = $1 AND repo_full_name = $2`,
            [userId, repo, JSON.stringify(stamp)],
        );
        // File-grained tech: stamp metadata.file_tech_stack onto each chunk from
        // the deterministic tech-extractor's per-file evidence. Repo-level
        // repo_tech_stack is too coarse for the retrieval pre-filter (one tech
        // anywhere in a ~90-tech monorepo admits every chunk); file_tech_stack
        // lets filter-then-rank gate a monitoring YAML out of a Python/LLM JD.
        // Set-based: one UPDATE joins the per-file canonical aggregate. Chunks
        // whose file has no code-layer evidence (prose/docs) get no key and the
        // retrieval filter falls back to repo_tech_stack, preserving recall.
        await pool.query(
            `UPDATE document_embeddings d
                SET metadata = COALESCE(d.metadata, '{}'::jsonb)
                             || jsonb_build_object('file_tech_stack', ft.tech)
               FROM (
                 SELECT te.file_path,
                        array_agg(DISTINCT lower(o.canonical_name)) AS tech
                   FROM technology_evidence te
                   JOIN technology_ontology o ON o.id = te.technology_id
                  WHERE te.user_id = $1 AND te.repo_full_name = $2
                    AND te.source_layer = ANY($3)
                  GROUP BY te.file_path
               ) ft
              WHERE d.user_id = $1 AND d.repo_full_name = $2
                AND d.file_path = ft.file_path`,
            [userId, repo, CODE_LAYERS],
        );
        stamped += 1;
    }
    return stamped;
}

async function githubLogin(pool: Pool, userId: string): Promise<string> {
    const { rows } = await pool.query<{ username: string }>(
        `SELECT username FROM oauth_connections
          WHERE user_id = $1 AND provider = 'github' AND revoked_at IS NULL
          ORDER BY connected_at DESC NULLS LAST LIMIT 1`,
        [userId],
    );
    return rows[0]?.username ?? '';
}

async function distinctRepos(pool: Pool, userId: string): Promise<string[]> {
    const { rows } = await pool.query<{ repo_full_name: string }>(
        `SELECT DISTINCT repo_full_name FROM document_embeddings WHERE user_id = $1`,
        [userId],
    );
    return rows.map((r) => r.repo_full_name);
}

async function profileMap(pool: Pool, userId: string): Promise<Map<string, { classification: string | null; qualityScore: number | null }>> {
    const { rows } = await pool.query<{ repo_full_name: string; classification: string | null; quality_score: number | null }>(
        `SELECT repo_full_name, classification, quality_score FROM repository_profiles WHERE user_id = $1`,
        [userId],
    );
    const map = new Map<string, { classification: string | null; qualityScore: number | null }>();
    for (const r of rows) map.set(r.repo_full_name, { classification: r.classification, qualityScore: r.quality_score });
    return map;
}

async function authoredRepoSet(pool: Pool, userId: string, login: string): Promise<Set<string>> {
    if (login.length === 0) return new Set();
    const { rows } = await pool.query<{ repo_full_name: string }>(
        `SELECT DISTINCT repo_full_name FROM repo_commits
          WHERE user_id = $1 AND lower(author_login) = lower($2)`,
        [userId, login],
    );
    return new Set(rows.map((r) => r.repo_full_name));
}

async function techStackMap(pool: Pool, userId: string): Promise<Map<string, string[]>> {
    const { rows } = await pool.query<{ repo_full_name: string; tech: string[] }>(
        `SELECT te.repo_full_name, array_agg(DISTINCT lower(o.canonical_name)) AS tech
           FROM technology_evidence te
           JOIN technology_ontology o ON o.id = te.technology_id
          WHERE te.user_id = $1 AND te.source_layer = ANY($2)
          GROUP BY te.repo_full_name`,
        [userId, CODE_LAYERS],
    );
    const map = new Map<string, string[]>();
    for (const r of rows) map.set(r.repo_full_name, r.tech ?? []);
    return map;
}
