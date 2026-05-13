/**
 * @format
 * Retrieval — Public API
 *
 * Reranking and other retrieval-time components. Keeps these out of the
 * `rds/` namespace because they are storage-agnostic — the same reranker
 * works for Bedrock KB (Pinecone) candidates and RDS pgvector candidates.
 */

export type {
    IReranker,
    RerankCandidate,
    RerankResult,
    RerankOptions,
} from './interfaces/IReranker.js';

export { BedrockReranker } from './implementations/BedrockReranker.js';
export type { BedrockRerankerConfig } from './implementations/BedrockReranker.js';

export type {
    RetrievedPassage,
    RetrieveOptions,
} from './implementations/PgVectorRetriever.js';

export { PgVectorRetriever } from './implementations/PgVectorRetriever.js';
