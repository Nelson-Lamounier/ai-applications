/**
 * @format
 * Inline evidence-stamp inputs for `UNIFIED_INGESTION=on` (P1 unified
 * ingestion, Task 4) — the in-memory equivalent of
 * `apply-evidence-stamp.ts`'s `stampUserEvidenceMetadata`, scoped to ONE repo
 * and returned as data instead of an `UPDATE`.
 *
 * Runs the same four source queries as the post-hoc pass (login, profile
 * classification/quality, commit authorship, per-file code-layer tech) —
 * scoped with a `repo_full_name` predicate instead of scanning every repo the
 * user has ingested — and reuses `buildEvidenceStamp` so the resulting keys
 * are byte-identical to what the post-hoc pass would have written.
 *
 * Called from a lazy `stampProvider` invoked once at the start of
 * `IngestionPipeline.ingestChunks`' embed+upsert phase — by which point the
 * orchestrator has already persisted this run's `repo_commits` (step 3.5), so
 * `userAuthored` reflects real commit authorship for THIS run rather than a
 * stale prior sync.
 */

import type { Pool } from 'pg';
import { buildEvidenceStamp, type EvidenceStamp, type RepoSignals } from '@bedrock/shared';

/** Source layers apply-evidence-stamp.ts treats as "code-derived" (not README prose). */
const CODE_LAYERS = ['syft', 'treesitter', 'iac', 'dockerfile'];

/** owner/repo → owner. */
function ownerOf(repoFullName: string): string {
    return repoFullName.split('/')[0] ?? '';
}

export interface InlineStampInputs {
    /** Merged into every chunk's metadata (repo-wide stamp). */
    readonly repoStamp: EvidenceStamp;
    /** filePath -> canonical tech, merged as `metadata.file_tech_stack` for files with code-layer evidence. */
    readonly fileTechMap: Map<string, string[]>;
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

async function repoProfile(
    pool: Pool, userId: string, repoFullName: string,
): Promise<{ classification: string | null; qualityScore: number | null }> {
    const { rows } = await pool.query<{ classification: string | null; quality_score: number | null }>(
        `SELECT classification, quality_score FROM repository_profiles WHERE user_id = $1 AND repo_full_name = $2`,
        [userId, repoFullName],
    );
    return { classification: rows[0]?.classification ?? null, qualityScore: rows[0]?.quality_score ?? null };
}

async function isAuthored(pool: Pool, userId: string, repoFullName: string, login: string): Promise<boolean> {
    if (login.length === 0) return false;
    const { rows } = await pool.query<{ n: string }>(
        `SELECT count(*)::int AS n FROM repo_commits
          WHERE user_id = $1 AND repo_full_name = $2 AND lower(author_login) = lower($3)`,
        [userId, repoFullName, login],
    );
    return Number(rows[0]?.n ?? 0) > 0;
}

async function techByFile(
    pool: Pool, userId: string, repoFullName: string,
): Promise<{ techStack: string[]; fileTechMap: Map<string, string[]> }> {
    const { rows } = await pool.query<{ file_path: string | null; tech: string[] | null }>(
        `SELECT te.file_path, array_agg(DISTINCT lower(o.canonical_name)) AS tech
           FROM technology_evidence te
           JOIN technology_ontology o ON o.id = te.technology_id
          WHERE te.user_id = $1 AND te.repo_full_name = $2 AND te.source_layer = ANY($3)
          GROUP BY te.file_path`,
        [userId, repoFullName, CODE_LAYERS],
    );
    const fileTechMap = new Map<string, string[]>();
    const techSet = new Set<string>();
    for (const r of rows) {
        const tech = r.tech ?? [];
        for (const t of tech) techSet.add(t);
        if (r.file_path) fileTechMap.set(r.file_path, tech);
    }
    return { techStack: [...techSet], fileTechMap };
}

/**
 * Build the stamp inputs for one repo. Four queries, scoped to `repoFullName`
 * — mirrors `stampUserEvidenceMetadata`'s per-repo loop body but returns the
 * result instead of issuing an `UPDATE`.
 */
export async function buildInlineStampInputs(
    pool: Pool, userId: string, repoFullName: string,
): Promise<InlineStampInputs> {
    const login = await githubLogin(pool, userId);
    const [profile, authored, tech] = await Promise.all([
        repoProfile(pool, userId, repoFullName),
        isAuthored(pool, userId, repoFullName, login),
        techByFile(pool, userId, repoFullName),
    ]);

    const signals: RepoSignals = {
        repoFullName,
        classification: profile.classification,
        qualityScore:   profile.qualityScore,
        ownerIsUser:    login.length > 0 && ownerOf(repoFullName).toLowerCase() === login.toLowerCase(),
        userAuthored:   authored,
        techStack:      tech.techStack,
        domain:         null,
    };

    return { repoStamp: buildEvidenceStamp(signals), fileTechMap: tech.fileTechMap };
}
