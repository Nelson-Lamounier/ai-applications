/**
 * @format
 * Aurora pgvector — Domain Types
 *
 * Value types shared across interfaces, implementations, and the pipeline.
 * No business logic — pure data shapes.
 */

// =============================================================================
// RAW CHUNK — pipeline input (no embedding, no user/repo context)
// =============================================================================

/**
 * A document chunk as it arrives at the pipeline boundary.
 * The pipeline adds userId, repoFullName, contentHash, and embedding before
 * persisting. Keeping these fields absent here enforces that the chunking
 * layer has no knowledge of who owns the data or how it will be embedded.
 */
export interface RawChunk {
    readonly filePath: string;
    readonly heading?: string;
    readonly content: string;
    readonly fileType?: string;
    readonly tags?: string[];
    readonly chunkIndex: number;
    readonly totalChunks: number;
}

// =============================================================================
// DOCUMENT CHUNK — storage type (fully resolved)
// =============================================================================

/**
 * A chunk ready for persistence. Extends RawChunk with:
 *   - userId / repoFullName: ownership context added by the pipeline
 *   - contentHash: SHA-256 of content, used for deduplication
 *   - embedding: 1024-dim float32 vector from Titan Embed v2
 */
export interface DocumentChunk extends RawChunk {
    readonly userId: string;
    readonly repoFullName: string;
    readonly contentHash: string;
    readonly embedding: number[];
}

// =============================================================================
// UPSERT RESULT
// =============================================================================

export interface UpsertBatchResult {
    readonly inserted: number;
    readonly updated: number;
    readonly skipped: number;
    readonly errors: number;
}

// =============================================================================
// CONTENT HASH CHECK — deduplication before embedding
// =============================================================================

export interface ChunkIdentity {
    readonly filePath: string;
    readonly chunkIndex: number;
    readonly contentHash: string;
}

/**
 * Output of IVectorStore.checkContentHashes.
 * The pipeline embeds only `stale` and `missing` entries.
 */
export interface HashCheckResult {
    /** No DB row — must embed and insert */
    readonly missing: ChunkIdentity[];
    /** DB row exists, hash changed — must re-embed and update */
    readonly stale: ChunkIdentity[];
    /** DB row exists, hash matches — skip embedding */
    readonly unchanged: ChunkIdentity[];
}

// =============================================================================
// SIMILARITY SEARCH
// =============================================================================

export interface SimilarityResult {
    readonly id: string;
    readonly repoFullName: string;
    readonly filePath: string;
    readonly heading: string | null;
    readonly content: string;
    readonly chunkIndex: number;
    readonly tags: string[];
    /** Cosine similarity: 1 − cosine_distance. Range [0, 1]. */
    readonly similarity: number;
}

export interface QueryParams {
    readonly userId: string;
    readonly repoFullName?: string;
    readonly queryEmbedding: number[];
    readonly limit?: number;
    /** Default 40. Only raise with measured evidence of recall degradation. */
    readonly efSearch?: number;
}

// =============================================================================
// SYNC STATE
// =============================================================================

export type SyncStatus = 'pending' | 'syncing' | 'complete' | 'error';

export interface RepoSyncState {
    readonly userId: string;
    readonly repoFullName: string;
    readonly syncStatus: SyncStatus;
    readonly lastSyncedAt?: Date;
    readonly fileCount: number;
    readonly chunkCount: number;
    readonly errorMessage?: string;
}

// =============================================================================
// INGESTION REPORT — pipeline output
// =============================================================================

export interface IngestionReport {
    readonly userId: string;
    readonly repoFullName: string;
    readonly totalRawChunks: number;
    readonly embedded: number;
    readonly skipped: number;
    readonly upsertResult: UpsertBatchResult;
    readonly durationMs: number;
}
