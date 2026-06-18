/** @format */
import type { Pool } from 'pg';

/**
 * Default cosine-similarity floor for accepting a nearest-canonical match.
 * Conservative on purpose — below this a free-text phrase keeps its raw form
 * rather than risk collapsing two genuinely distinct skills. The production
 * value is set by the resolution eval (sub-slice D) before the enricher is
 * wired (sub-slice C); this default only governs ad-hoc use.
 */
export const DEFAULT_SKILL_MATCH_THRESHOLD = 0.62;

export interface SkillMatch {
    readonly canonical: string;
    readonly similarity: number;
}

/**
 * Nearest-canonical skill resolver over Titan embeddings (migration 094).
 *
 * The fuzzy counterpart to the exact-alias OntologyResolver: given a free-text
 * skill phrase's embedding, return the nearest canonical skill whose cosine
 * similarity clears the threshold, else null (caller keeps the raw phrase). This
 * is what collapses the long tail of descriptive LLM output ("auto scaling group
 * configuration" -> "aws auto scaling") that exact matching cannot.
 *
 * Reference data (skill_ontology) is not user-scoped, so no RLS context needed.
 */
export class SkillEmbeddingResolver {
    constructor(
        private readonly pool: Pool,
        private readonly threshold: number = DEFAULT_SKILL_MATCH_THRESHOLD,
    ) {}

    /** @returns the nearest canonical skill above the threshold, or null. */
    async resolveByVector(queryVec: readonly number[]): Promise<SkillMatch | null> {
        if (queryVec.length === 0) return null;
        const literal = `[${queryVec.join(',')}]`;
        const { rows } = await this.pool.query<{ canonical_name: string; similarity: number }>(
            `SELECT canonical_name, 1 - (embedding <=> $1::vector) AS similarity
               FROM skill_ontology
              WHERE embedding IS NOT NULL
              ORDER BY embedding <=> $1::vector
              LIMIT 1`,
            [literal],
        );
        const top = rows[0];
        if (!top || top.similarity < this.threshold) return null;
        return { canonical: top.canonical_name, similarity: top.similarity };
    }
}
