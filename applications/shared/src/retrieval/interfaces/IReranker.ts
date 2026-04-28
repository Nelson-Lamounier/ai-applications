/**
 * @format
 * IReranker — Cross-encoder reranking contract.
 *
 * Sits between vector/BM25 retrieval and the LLM context. Standard RAG
 * pipeline: top-50 from hybrid retrieval → rerank → top-K (typically 10)
 * → LLM. Cross-encoder reranking is materially more accurate than
 * cosine similarity at small candidate counts because it actually reads
 * the query and the candidate together; bi-encoder retrieval only gets
 * you to "candidate-shaped neighbourhood".
 *
 * Implementations:
 *   - BedrockReranker (production) — Bedrock Rerank API
 *   - StaticIdentityReranker (tests) — passes candidates through unchanged
 *   - No-op fallback when the caller wants to disable reranking entirely
 *
 * Failure semantics:
 *   Best-effort. The caller should treat a thrown error or empty result
 *   as "fall back to the original ordering, take top-K". This keeps a
 *   bad rerank API call from breaking the resume pipeline.
 */

export interface RerankCandidate {
    /** Caller-defined opaque id. Returned in `RerankResult.id`. */
    readonly id:   string;
    /** Text the reranker scores against the query. ≤ ~5000 chars typical. */
    readonly text: string;
}

export interface RerankResult {
    readonly id:             string;
    /** Reranker relevance score, 0..1 (higher = more relevant). */
    readonly relevanceScore: number;
    /** Position of this candidate in the input array (for back-mapping). */
    readonly originalIndex:  number;
}

export interface RerankOptions {
    /** Number of top candidates to return. Default = candidates.length. */
    readonly topK?: number;
}

export interface IReranker {
    rerank(
        query:       string,
        candidates:  readonly RerankCandidate[],
        opts?:       RerankOptions,
    ): Promise<RerankResult[]>;
}
