/** @format */
import type { Pool } from 'pg';

export interface OntologyReviewQueueInput {
    rawName:            string;
    ecosystem:          string;
    source:             string;
    reason:             string;
    suggestedCategory?: string | null;
    llmReasoning?:      string | null;
}

/**
 * Records an ontology import entry needing human review. Global table
 * (no RLS). Dedups on (raw_name, ecosystem) — re-adds are no-ops.
 */
export class OntologyReviewQueueRepository {
    constructor(private readonly pool: Pool) {}

    async add(input: OntologyReviewQueueInput): Promise<void> {
        await this.pool.query(
            `INSERT INTO ontology_review_queue
                (raw_name, ecosystem, source, reason, suggested_category, llm_reasoning)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (raw_name, ecosystem) DO NOTHING`,
            [
                input.rawName,
                input.ecosystem,
                input.source,
                input.reason,
                input.suggestedCategory ?? null,
                input.llmReasoning ?? null,
            ],
        );
    }
}
