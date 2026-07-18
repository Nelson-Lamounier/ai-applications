/** @format */
import type { Pool } from 'pg';
import { withUserRls } from '../with-user-rls.js';
import { toPurl } from '../../sbom/purl.js';
import {
    buildCycloneDxBom,
    technologyEvidenceToComponents,
    preferSpecificPurls,
    type CycloneDxBom,
} from '../../sbom/cyclonedx.js';
import type { TechnologyEvidenceRow } from '../types/techgraph.js';

export class TechnologyEvidenceRepository {
    constructor(private readonly pool: Pool) {}

    /** Commit-SHA short-circuit: has this exact commit already been extracted? */
    async hasEvidenceForCommit(userId: string, repoFullName: string, commitSha: string): Promise<boolean> {
        return withUserRls(this.pool, userId, async (client) => {
            const { rows } = await client.query(
                `SELECT 1 FROM technology_evidence
                 WHERE user_id = $1::uuid AND repo_full_name = $2 AND commit_sha = $3
                 LIMIT 1`,
                [userId, repoFullName, commitSha],
            );
            return rows.length > 0;
        });
    }

    /** Insert a batch; duplicates (per uq_technology_evidence) are skipped. */
    async insertMany(userId: string, rows: TechnologyEvidenceRow[]): Promise<void> {
        if (rows.length === 0) return;
        await withUserRls(this.pool, userId, async (client) => {
            for (const r of rows) {
                // Canonical purl derived here (the single persistence boundary) so
                // every writer gets identity consistent with migration 089's backfill.
                const purl = toPurl({ ecosystem: r.ecosystem ?? '', name: r.rawName, version: r.version ?? undefined });
                await client.query(
                    `INSERT INTO technology_evidence (
                        user_id, repo_full_name, commit_sha, technology_id, raw_name,
                        ecosystem, source_layer, file_path, line_start, line_end,
                        confidence, extracted_at_ontology_version, version, purl,
                        github_repo_id
                    ) VALUES (
                        $1::uuid, $2, $3, $4::uuid, $5,
                        $6, $7, $8, $9, $10,
                        $11, $12, $13, $14, $15
                    )
                    -- Refresh volatile provenance on re-extract (the unique key is
                    -- tech+file+line, NOT commit) so a force-reindex backfills
                    -- version/purl/github_repo_id onto existing rows instead of
                    -- skipping them. Matches uq_technology_evidence exactly.
                    ON CONFLICT (user_id, repo_full_name, COALESCE(technology_id::text, raw_name), file_path, COALESCE(line_start, -1))
                    DO UPDATE SET
                        commit_sha                    = EXCLUDED.commit_sha,
                        version                       = EXCLUDED.version,
                        purl                          = EXCLUDED.purl,
                        github_repo_id                = EXCLUDED.github_repo_id,
                        extracted_at_ontology_version = EXCLUDED.extracted_at_ontology_version`,
                    [
                        userId, r.repoFullName, r.commitSha, r.technologyId, r.rawName,
                        r.ecosystem, r.sourceLayer, r.filePath, r.lineStart, r.lineEnd,
                        r.confidence, r.ontologyVersion, r.version, purl,
                        r.githubRepoId,
                    ],
                );
            }
        });
    }

    /**
     * Export a repo's technology evidence as a CycloneDX 1.6 SBOM (the standard
     * interchange format). Components are deduped on purl, preferring a
     * package-ecosystem purl over a `generic` one for the same tool. purl is
     * re-derived via the canonical toPurl() so this works regardless of whether
     * the stored `purl` column has been backfilled.
     */
    async toCycloneDxBom(userId: string, repoFullName: string): Promise<CycloneDxBom> {
        return withUserRls(this.pool, userId, async (client) => {
            const { rows } = await client.query<{
                raw_name: string; ecosystem: string | null; version: string | null; commit_sha: string;
            }>(
                `SELECT DISTINCT raw_name, ecosystem, version, commit_sha
                   FROM technology_evidence
                  WHERE user_id = $1::uuid AND repo_full_name = $2`,
                [userId, repoFullName],
            );
            const components = preferSpecificPurls(technologyEvidenceToComponents(
                rows.map(r => ({ rawName: r.raw_name, ecosystem: r.ecosystem, version: r.version ?? undefined })),
            ));
            return buildCycloneDxBom(components, { repoFullName, commitSha: rows[0]?.commit_sha });
        });
    }
}
