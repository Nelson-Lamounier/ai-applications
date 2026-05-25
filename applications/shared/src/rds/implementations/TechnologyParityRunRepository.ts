/** @format */
import type { Pool } from 'pg';
import type { ParityRunRow } from '../types/techgraph.js';

export class TechnologyParityRunRepository {
    constructor(private readonly pool: Pool) {}

    async insert(run: ParityRunRow): Promise<void> {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [run.userId]);
            await client.query(
                `INSERT INTO technology_parity_runs (
                    user_id, repo_full_name, commit_sha, ontology_version,
                    l1_canonical_count, llm_canonical_count, llm_unresolvable_count,
                    intersection_count, recall, l1_only_examples, llm_only_examples
                 ) VALUES (
                    $1::uuid, $2, $3, $4,
                    $5, $6, $7,
                    $8, $9, $10::jsonb, $11::jsonb
                 )`,
                [
                    run.userId, run.repoFullName, run.commitSha, run.ontologyVersion,
                    run.l1CanonicalCount, run.llmCanonicalCount, run.llmUnresolvableCount,
                    run.intersectionCount, run.recall,
                    JSON.stringify(run.l1OnlyExamples), JSON.stringify(run.llmOnlyExamples),
                ],
            );
            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw err;
        } finally {
            client.release();
        }
    }
}
