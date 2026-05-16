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
}
