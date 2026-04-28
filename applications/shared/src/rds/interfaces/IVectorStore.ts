/**
 * @format
 * IVectorStore — Vector Storage and Retrieval Contract
 *
 * Defines all operations the pipeline and query layer need from a vector store.
 * Implementations may back this with Aurora pgvector, Pinecone, or any other
 * vector database — the pipeline never imports a concrete implementation.
 */

import type {
    ChunkIdentity,
    DocumentChunk,
    HashCheckResult,
    QueryParams,
    SimilarityResult,
    UpsertBatchResult,
} from '../types.js';

export interface IVectorStore {
    /**
     * Persist a batch of pre-embedded document chunks.
     * Uses upsert semantics: insert new chunks, update changed ones (by
     * content_hash), skip unchanged ones. Sequential — not parallel.
     */
    upsertBatch(chunks: DocumentChunk[]): Promise<UpsertBatchResult>;

    /**
     * Nearest-neighbour similarity search within a user's documents.
     * Optionally narrows to a single repo via QueryParams.repoFullName.
     */
    querySimilar(params: QueryParams): Promise<SimilarityResult[]>;

    /**
     * Compare caller-supplied content hashes against stored values for a
     * specific (userId, repoFullName). Returns three buckets so the pipeline
     * can skip re-embedding unchanged chunks.
     */
    checkContentHashes(
        userId: string,
        repoFullName: string,
        candidates: ChunkIdentity[],
    ): Promise<HashCheckResult>;

    /**
     * Delete all stored chunks for a (userId, repoFullName).
     * Used when a repo is removed or a full re-index is forced.
     * Returns the number of deleted rows.
     */
    deleteChunksByRepo(userId: string, repoFullName: string): Promise<number>;

    /**
     * Delete chunks whose file_path is NOT in currentFilePaths for a given
     * (userId, repoFullName). Called after every successful upsert to garbage-
     * collect stale chunks left by deleted or renamed files.
     * Returns the number of deleted rows.
     */
    pruneDeletedFiles(
        userId: string,
        repoFullName: string,
        currentFilePaths: string[],
    ): Promise<number>;
}
