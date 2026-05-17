/**
 * @format
 * Semantic cache — contract. Embed a (PII-scrubbed, normalised) query,
 * cosine-match it against prior cached responses scoped by app/caller and
 * a KB-version/model tag. Fail-open: errors degrade to miss / no-op.
 */

export interface SemanticCacheGetInput {
    readonly scope: string;
    readonly kbTag: string;
    readonly queryText: string;
}

export interface SemanticCacheGetResult {
    readonly hit: boolean;
    readonly response?: unknown;
    readonly similarity?: number;
}

export interface SemanticCachePutInput {
    readonly scope: string;
    readonly kbTag: string;
    readonly queryText: string;
    readonly response: unknown;
}

export interface ISemanticCache {
    get(input: SemanticCacheGetInput): Promise<SemanticCacheGetResult>;
    put(input: SemanticCachePutInput): Promise<void>;
    /**
     * Purge cached responses on knowledge-base or model changes. Returns the
     * number of rows removed. Fail-open: errors degrade to 0 / no-op.
     */
    invalidate(input: SemanticCacheInvalidateInput): Promise<number>;
}

export interface SemanticCacheInvalidateInput {
    /** Restrict deletion to one app/caller scope. Omit to match any scope. */
    readonly scope?: string;
    /** Restrict deletion to one KB-version/model tag. Omit to match any tag. */
    readonly kbTag?: string;
}
