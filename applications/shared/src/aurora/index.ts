/**
 * @format
 * Aurora pgvector — Public API
 *
 * Consumers import from this barrel — never from sub-paths.
 *
 * Structure:
 *   types        — pure domain value types
 *   interfaces   — contracts (IVectorStore, ISyncStateRepository, IEmbeddingProvider)
 *   implementations — concrete AWS-backed classes (Aurora, Titan)
 *   pipeline     — IngestionPipeline orchestrator
 */

// Domain types
export type {
    RawChunk,
    DocumentChunk,
    UpsertBatchResult,
    ChunkIdentity,
    HashCheckResult,
    SimilarityResult,
    QueryParams,
    RepoSyncState,
    SyncStatus,
    IngestionReport,
} from './types.js';

// Interfaces
export type { IVectorStore }          from './interfaces/IVectorStore.js';
export type { ISyncStateRepository }  from './interfaces/ISyncStateRepository.js';
export type { IEmbeddingProvider }    from './interfaces/IEmbeddingProvider.js';

// Implementations
export { AuroraVectorStore }          from './implementations/AuroraVectorStore.js';
export type { AuroraClientConfig }    from './implementations/AuroraVectorStore.js';
export { AuroraSyncStateRepository }  from './implementations/AuroraSyncStateRepository.js';
export { TitanEmbeddingProvider }     from './implementations/TitanEmbeddingProvider.js';

// Pipeline
export { IngestionPipeline }          from './pipeline/IngestionPipeline.js';
