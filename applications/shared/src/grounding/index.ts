/**
 * @format
 * Grounding — Public API.
 *
 * Checklist section 6: self-correction / answer grounding. Verifies a
 * generated answer is supported by its retrieved context via a cheap
 * Bedrock model. Mode is per-app: query apps 'block' (substitute a
 * fallback when NOT_GROUNDED), pipeline apps 'flag' (annotate + emit
 * metrics, return the original answer). Storage-agnostic — works with
 * any retrieval source's context chunks.
 */

export { BedrockGroundingVerifier } from './bedrock-grounding-verifier.js';
export type { BedrockGroundingVerifierConfig } from './bedrock-grounding-verifier.js';
export { DEFAULT_GROUNDING_FALLBACK } from './grounding-types.js';
export type {
    GroundingInput,
    GroundingMode,
    GroundingResult,
    IGroundingVerifier,
} from './grounding-types.js';
