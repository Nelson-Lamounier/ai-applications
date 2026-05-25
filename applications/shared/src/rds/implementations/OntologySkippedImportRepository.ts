/** @format */
import type { Pool } from 'pg';

export interface OntologySkippedImportInput {
    rawName:       string;
    ecosystem:     string;
    source:        string;
    llmDecision:   string;
    llmReasoning?: string | null;
    llmRunId?:     string | null;
}

/**
 * Records an ontology import entry the LLM chose to skip. Global table
 * (no RLS). Dedups on (raw_name, ecosystem) — re-adds are no-ops.
 */
export class OntologySkippedImportRepository {
    constructor(private readonly pool: Pool) {}

    async add(input: OntologySkippedImportInput): Promise<void> {
        await this.pool.query(
            `INSERT INTO ontology_skipped_imports
                (raw_name, ecosystem, source, llm_decision, llm_reasoning, llm_run_id)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (raw_name, ecosystem) DO NOTHING`,
            [
                input.rawName,
                input.ecosystem,
                input.source,
                input.llmDecision,
                input.llmReasoning ?? null,
                input.llmRunId ?? null,
            ],
        );
    }
}
