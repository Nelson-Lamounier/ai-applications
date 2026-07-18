/**
 * @format
 * Persistence for `concept_evidence` (migration 123) — concept-detector facts
 * (see `ConceptPatternExtractor.ts`) resolved through the shared skill
 * ontology infrastructure: `SkillOntologyRepository.loadAliasMap()` loads
 * alias -> skill_id, and `OntologyResolver` (built from that map) resolves
 * each row's `conceptAlias` with the shared strict `normalizeAlias`
 * (lowercase + trim) — the same resolve idiom `run-facts-stage.ts` uses for
 * the tech lane's `TechnologyOntologyRepository`. `RepoFactsRepository`'s RLS
 * writer pattern still applies: every write runs through the shared
 * `withUserRls(pool, userId, fn)` helper, which demotes the transaction to
 * `tucaken_app` via `SET LOCAL ROLE` and stamps
 * `SELECT set_config('app.current_user_id', $1, true)` so the
 * `rls_concept_evidence` policy actually authorises the write. COMMIT on
 * success, ROLLBACK on error, release the client in `finally` — all handled
 * by the shared helper.
 *
 * Unresolved `conceptAlias` values (no seeded skill_aliases row) are logged
 * and skipped — never thrown. A missing ontology seed must not break a run
 * (same fail-open discipline as the DSA/AI lanes' resolver skip path).
 */
import type { Pool } from 'pg';
import { jobLogger, OntologyResolver, SkillOntologyRepository, withUserRls } from '@bedrock/shared';

import type { RawConceptEvidence } from '../facts/extractors/ConceptPatternExtractor.js';

export class RdsConceptEvidenceRepository {
    private readonly ontologyRepo: SkillOntologyRepository;

    constructor(private readonly pool: Pool) {
        this.ontologyRepo = new SkillOntologyRepository(pool);
    }

    /**
     * Resolves each row's `conceptAlias` through the shared ontology resolver
     * and upserts. Idempotent via
     * `(user_id, repo_full_name, skill_id, detector, file_path)`: a re-run
     * bumps commit_sha/line_start/confidence/extracted_at on conflict.
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
        const resolver = new OntologyResolver(await this.ontologyRepo.loadAliasMap());

        const resolved: Array<{ skillId: string; row: RawConceptEvidence }> = [];
        for (const row of rows) {
            const skillId = resolver.resolve(row.conceptAlias);
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

        await withUserRls(this.pool, userId, async (client) => {
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
        });
    }
}
