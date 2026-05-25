/** @format */
import type { Pool } from 'pg';
import type { TechnologyEvidenceRow } from '../types/techgraph.js';

export class TechnologyEvidenceRepository {
    constructor(private readonly pool: Pool) {}

    /** Commit-SHA short-circuit: has this exact commit already been extracted? */
    async hasEvidenceForCommit(userId: string, repoFullName: string, commitSha: string): Promise<boolean> {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [userId]);
            const { rows } = await client.query(
                `SELECT 1 FROM technology_evidence
                 WHERE user_id = $1::uuid AND repo_full_name = $2 AND commit_sha = $3
                 LIMIT 1`,
                [userId, repoFullName, commitSha],
            );
            await client.query('COMMIT');
            return rows.length > 0;
        } finally {
            client.release();
        }
    }

    /** Insert a batch; duplicates (per uq_technology_evidence) are skipped. */
    async insertMany(userId: string, rows: TechnologyEvidenceRow[]): Promise<void> {
        if (rows.length === 0) return;
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [userId]);
            for (const r of rows) {
                await client.query(
                    `INSERT INTO technology_evidence (
                        user_id, repo_full_name, commit_sha, technology_id, raw_name,
                        ecosystem, source_layer, file_path, line_start, line_end,
                        confidence, extracted_at_ontology_version
                    ) VALUES (
                        $1::uuid, $2, $3, $4::uuid, $5,
                        $6, $7, $8, $9, $10,
                        $11, $12
                    )
                    ON CONFLICT (
                        user_id, repo_full_name,
                        COALESCE(technology_id::text, raw_name),
                        file_path, COALESCE(line_start, -1)
                    ) DO NOTHING`,
                    [
                        userId, r.repoFullName, r.commitSha, r.technologyId, r.rawName,
                        r.ecosystem, r.sourceLayer, r.filePath, r.lineStart, r.lineEnd,
                        r.confidence, r.ontologyVersion,
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
