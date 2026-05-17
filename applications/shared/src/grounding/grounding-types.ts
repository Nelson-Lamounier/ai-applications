/**
 * @format
 * Grounding types — checklist section 6 self-correction contract.
 *
 * Verifies a generated answer is supported by its retrieved context.
 * Mode is per-app: query apps use 'block', pipeline apps use 'flag'.
 */

export type GroundingMode = 'block' | 'flag';

export interface GroundingInput {
    readonly query: string;
    readonly contextChunks: readonly string[];
    readonly answer: string;
}

export interface GroundingResult {
    readonly status: 'GROUNDED' | 'NOT_GROUNDED';
    readonly reason: string;
    readonly ungroundedClaims: readonly string[];
    /**
     * Answer to return to the caller. In 'flag' mode this is always the
     * original answer. In 'block' mode it is the fallback string when
     * status is NOT_GROUNDED, otherwise the original answer.
     */
    readonly answer: string;
}

export interface IGroundingVerifier {
    verify(input: GroundingInput): Promise<GroundingResult>;
}

export const DEFAULT_GROUNDING_FALLBACK =
    "I don't have enough grounded information to answer that confidently.";
