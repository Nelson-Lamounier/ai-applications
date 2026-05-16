/**
 * @format
 * Grounding — Public API. Checklist section 6 self-correction / answer grounding.
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
