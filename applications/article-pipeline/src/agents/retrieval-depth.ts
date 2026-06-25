/**
 * @format
 * Mode-aware pgvector retrieval depth for the research agent.
 *
 * Extracted into its own module (no AWS-client or env side effects) so the
 * golden eval can import the EXACT depth the research agent uses in production
 * without loading the whole agent. The two must never drift — that is the point
 * of sharing this single source of truth.
 */
import type { PipelineMode } from '@bedrock/shared';

export interface PgVectorDepth {
    maxProfiles: number;
    maxChunks: number;
    neighbourRadius: number;
    boostByRepoSignals?: string[];
}

/**
 * The pipeline mode is a proxy for how much the article must lean on the user
 * KB rather than the draft itself:
 *
 *   - 'kb-augmented'   — a short prompt (≤ KB_AUGMENTED_THRESHOLD chars) that is
 *                        mostly author direction ("write about my EKS work").
 *                        The substance has to come from the KB, so pull DEEP:
 *                        more profiles + chunks, wider neighbour context, and a
 *                        soft boost toward repos carrying real CI/IaC signal.
 *   - 'legacy-transform' — a long draft that already carries its own content;
 *                        the KB only supplements, so pull LIGHT to avoid drowning
 *                        the author's draft in retrieved passages.
 */
export const PGVECTOR_DEPTH: Record<PipelineMode, PgVectorDepth> = {
    'kb-augmented':     { maxProfiles: 6, maxChunks: 12, neighbourRadius: 2, boostByRepoSignals: ['has_ci', 'has_iac'] },
    'legacy-transform': { maxProfiles: 4, maxChunks: 6,  neighbourRadius: 1 },
};
