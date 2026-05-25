/** @format */
import type { Pool } from 'pg';

export interface CandidateUpsertInput {
    rawName:        string;
    normalizedName: string;
    ecosystem?:     string;
    userId:         string;
    repoFullName:   string;
    filePath:       string;
}

export class TechnologyCandidateRepository {
    constructor(private readonly pool: Pool) {}

    /**
     * Record an unmatched token. On repeat (same normalized_name + ecosystem)
     * increment occurrence_count and append the example repo.
     *
     * NOTE: user_count is initialised to 1 and not incremented here — a naive
     * +1 would double-count the same user. Distinct-user counts are derived
     * later from example_repos in the candidate-review loop (deferred).
     */
    async upsert(input: CandidateUpsertInput): Promise<void> {
        const ecosystem = input.ecosystem ?? 'unknown';
        const example = JSON.stringify([{ user_id: input.userId, repo: input.repoFullName, file_path: input.filePath }]);
        await this.pool.query(
            `INSERT INTO technology_candidates (
                raw_name, normalized_name, ecosystem,
                occurrence_count, user_count, example_repos
             ) VALUES ($1, $2, $3, 1, 1, $4::jsonb)
             ON CONFLICT (normalized_name, ecosystem) DO UPDATE SET
                occurrence_count = technology_candidates.occurrence_count + 1,
                example_repos    = technology_candidates.example_repos || EXCLUDED.example_repos`,
            [input.rawName, input.normalizedName, ecosystem, example],
        );
    }
}
