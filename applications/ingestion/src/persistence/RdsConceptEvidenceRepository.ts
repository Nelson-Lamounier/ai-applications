/**
 * @format
 * Persistence for `concept_evidence` (migration 123) — concept-detector facts
 * (see `ConceptPatternExtractor.ts`) resolved through the shared skill
 * ontology alias map, mirroring `SkillOntologyRepository.loadAliasMap()`'s
 * resolve pattern and `RepoFactsRepository`'s RLS writer pattern: every write
 * opens a transaction and stamps the current user with
 * `SELECT set_config('app.current_user_id', $1, true)` so the
 * `rls_concept_evidence` policy authorises the write. COMMIT on success,
 * ROLLBACK on error, release the client in `finally`.
 *
 * Unresolved `conceptAlias` values (no seeded skill_aliases row) are logged
 * and skipped — never thrown. A missing ontology seed must not break a run
 * (same fail-open discipline as the DSA/AI lanes' resolver skip path).
 */
import type { Pool } from 'pg';
import { jobLogger } from '@bedrock/shared';

import type { RawConceptEvidence } from '../facts/extractors/ConceptPatternExtractor.js';

export class RdsConceptEvidenceRepository {
    constructor(private readonly pool: Pool) {}

    /** alias -> skill_id (both sides lowercased), joined skill_aliases -> skill_ontology. */
    async loadAliasMap(): Promise<Map<string, string>> {
        const { rows } = await this.pool.query<{ alias: string; skill_id: string }>(
            `SELECT a.alias, a.skill_id
               FROM skill_aliases a
               JOIN skill_ontology o ON o.id = a.skill_id`,
        );
        const map = new Map<string, string>();
        for (const r of rows) map.set(r.alias.toLowerCase(), r.skill_id);
        return map;
    }

    /**
     * Resolves each row's `conceptAlias` through the alias map and upserts.
     * Idempotent via `(user_id, repo_full_name, skill_id, detector, file_path)`:
     * a re-run bumps commit_sha/line_start/confidence/extracted_at on conflict.
     */
    async insertMany(
        userId: string,
        repoFullName: string,
        githubRepoId: number | null,
        commitSha: string,
        rows: RawConceptEvidence[],
    ): Promise<void> {
        if (rows.length === 0) return;

        const log = jobLogger();
        const aliasMap = await this.loadAliasMap();

        const resolved: Array<{ skillId: string; row: RawConceptEvidence }> = [];
        for (const row of rows) {
            const skillId = aliasMap.get(row.conceptAlias.toLowerCase());
            if (!skillId) {
                log.warn(
                    { conceptAlias: row.conceptAlias, detector: row.detector, filePath: row.filePath },
                    'concept-evidence.alias-unresolved (skipped)',
                );
                continue;
            }
            resolved.push({ skillId, row });
        }
        if (resolved.length === 0) return;

        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [userId]);
            for (const { skillId, row } of resolved) {
                await client.query(
                    `INSERT INTO concept_evidence (
                       user_id, repo_full_name, github_repo_id, skill_id, detector, file_path, line_start, confidence, commit_sha
                     ) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9)
                     ON CONFLICT (user_id, repo_full_name, skill_id, detector, file_path) DO UPDATE
                       SET commit_sha   = EXCLUDED.commit_sha,
                           line_start   = EXCLUDED.line_start,
                           confidence   = EXCLUDED.confidence,
                           extracted_at = now()`,
                    [
                        userId,
                        repoFullName,
                        githubRepoId,
                        skillId,
                        row.detector,
                        row.filePath,
                        row.lineStart ?? null,
                        row.confidence,
                        commitSha,
                    ],
                );
            }
            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw err;
        } finally {
            client.release();
        }
    }
}
