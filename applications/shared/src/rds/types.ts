/**
 * @format
 * RDS pgvector — Domain Types
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
    /**
     * Structured per-chunk metadata. Persisted to `document_embeddings.metadata`
     * (JSONB). Populated by the chunker (e.g. parsed YAML frontmatter from
     * markdown files) and by future enrichment stages (skill_details, metrics,
     * timeline). Always present in the DB as `'{}'::jsonb` when no signal is
     * available.
     */
    readonly metadata?: Record<string, unknown>;
    /**
     * Domain capabilities the chunk evidences (e.g. "kubernetes networking",
     * "iac with cdk"). Lowercased, deduplicated. Persisted to
     * `document_embeddings.skills TEXT[]` (GIN-indexed). Populated by the
     * `IChunkEnricher` stage of the pipeline; absent or `[]` when no signal.
     */
    readonly skills?: string[];
    /**
     * Named tools, frameworks, services, and products in use within the chunk
     * (e.g. "calico", "traefik", "step functions"). Lowercased, deduplicated.
     * Persisted to `document_embeddings.technologies TEXT[]` (GIN-indexed).
     */
    readonly technologies?: string[];
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
    /**
     * Plain-text query string for full-text search (BM25 via tsvector).
     * Required when useHybrid is true — ignored otherwise.
     */
    readonly queryText?: string;
    /**
     * When true, combines HNSW vector search with BM25 full-text search using
     * Reciprocal Rank Fusion (RRF, k=60). Requires queryText to be set.
     * Falls back to vector-only if queryText is absent.
     */
    readonly useHybrid?: boolean;
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
    /** KB quality score in [0, 1], rounded to 2 decimals. */
    readonly kbQualityScore?: number;
    /** Per-factor breakdown matching `KbQualityBreakdown`. */
    readonly kbQualityBreakdown?: Record<string, unknown>;
    /** Retrieval-probe score in [0, 1], rounded to 2 decimals. */
    readonly retrievalScore?: number;
    /** Per-question breakdown matching `RetrievalBreakdown`. */
    readonly retrievalBreakdown?: Record<string, unknown>;
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
    /** Chunks deleted for file paths no longer present in the repo (Gap 6 GC). */
    readonly pruned: number;
    readonly upsertResult: UpsertBatchResult;
    readonly durationMs: number;
    /**
     * KB quality score in [0, 1] (rounded to 2 decimals). Pure derivation
     * over the ingested chunks — see `quality/computeKbQuality.ts`.
     * Persisted to `repo_sync_state.kb_quality_score`.
     */
    readonly kbQualityScore?: number;
    /**
     * Per-factor breakdown matching `KbQualityBreakdown`. Persisted as JSONB
     * so the UI can show *why* the score is what it is.
     */
    readonly kbQualityBreakdown?: Record<string, unknown>;
    /**
     * Retrieval-probe score in [0, 1] (rounded to 2 decimals). Best-effort —
     * absent when the probe is not configured, skipped, or failed. See
     * `quality/retrievalProbe.ts`. Persisted to
     * `repo_sync_state.retrieval_score`.
     */
    readonly retrievalScore?: number;
    /** Per-question breakdown matching `RetrievalBreakdown`. Persisted as JSONB. */
    readonly retrievalBreakdown?: Record<string, unknown>;
}
