/**
 * @format
 * RDS pgvector — Public API
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
export type { IChunkEnricher, ChunkEnrichment } from './interfaces/IChunkEnricher.js';

// Implementations
export { RdsVectorStore }            from './implementations/RdsVectorStore.js';
export type { RdsClientConfig }      from './implementations/RdsVectorStore.js';
export { RdsSyncStateRepository }    from './implementations/RdsSyncStateRepository.js';
export { TitanEmbeddingProvider }    from './implementations/TitanEmbeddingProvider.js';
export type { TitanCostContext }     from './implementations/TitanEmbeddingProvider.js';
export { BedrockChunkEnricher }      from './implementations/BedrockChunkEnricher.js';
export type { BedrockChunkEnricherConfig } from './implementations/BedrockChunkEnricher.js';

// Pipeline
export { IngestionPipeline }          from './pipeline/IngestionPipeline.js';
export type { IngestionPipelineOptions } from './pipeline/IngestionPipeline.js';

// Quality
export { computeKbQuality } from './quality/computeKbQuality.js';
export type {
    KbQualityFactor,
    KbQualityBreakdown,
    KbQualityResult,
} from './quality/computeKbQuality.js';

// Profile
export { computeUserProfileRollup } from './profile/computeUserProfileRollup.js';
export type {
    ProfileAggInput,
    LanguageStat,
    TechStat,
    ActivityArcEntry,
    UserProfileRollup,
    UserProfileRollupResult,
} from './profile/computeUserProfileRollup.js';

export type { IUserProfileRollupRepository, MirrorJson, RevealJson, ArchetypeFit, SeniorityCall, DirectionJson, UnsupportedClaim, UndersoldStrength, ReconciliationJson, DiagnosticJson, RollupRow } from './interfaces/IUserProfileRollupRepository.js';
export { RdsUserProfileRollupRepository } from './implementations/RdsUserProfileRollupRepository.js';

export type { ICareerHistoryReadRepository, ResumeForReconciliation, ResumeSkillGroup, ResumeExperienceEntry, ResumeProjectEntry } from './interfaces/ICareerHistoryReadRepository.js';
export { RdsCareerHistoryReadRepository } from './implementations/RdsCareerHistoryReadRepository.js';

export type { IDiagnosticInputsReadRepository, DiagnosticInputs, KbStats, ResumeEntryCounts } from './interfaces/IDiagnosticInputsReadRepository.js';
export { RdsDiagnosticInputsReadRepository } from './implementations/RdsDiagnosticInputsReadRepository.js';

export type { IOAuthConnectionsRepository, OAuthConnection, NewOAuthConnection } from './interfaces/IOAuthConnectionsRepository.js';
export { RdsOAuthConnectionsRepository } from './implementations/RdsOAuthConnectionsRepository.js';

// Diagnostic (pure deterministic formula)
export { computeUserDiagnostic, WEIGHTS, KB_SCORE_THRESHOLD } from './diagnostic/computeUserDiagnostic.js';
export type {
    ComponentKey,
    ComponentSubScore,
    DiagnosticComputed,
    DiagnosticComputeInput,
} from './diagnostic/computeUserDiagnostic.js';

export type {
    IRetrievalProbe,
    RetrievalProbeArgs,
    RetrievalBreakdown,
    RetrievalQuestionResult,
    RetrievalStatus,
    RankCandidate,
} from './quality/retrievalProbe.js';
export {
    sampleChunks,
    matchRank,
    scoreRetrieval,
    buildRetrievalSuggestions,
} from './quality/retrievalProbe.js';

// Bedrock cost tracking
export { recordBedrockCost, computeCostCents, recordInvocationToRds } from './bedrock-cost.js';
export type { CostRecord } from './bedrock-cost.js';

// Technology graph (Layer 1)
export { OntologyResolver, normalizeAlias } from './ontology/OntologyResolver.js';
export { TechnologyOntologyRepository }     from './implementations/TechnologyOntologyRepository.js';
export { TechnologyEvidenceRepository }     from './implementations/TechnologyEvidenceRepository.js';
export { TechnologyCandidateRepository }    from './implementations/TechnologyCandidateRepository.js';
export { TechnologyParityRunRepository }    from './implementations/TechnologyParityRunRepository.js';
export type {
    SourceLayer, RawTechnologyEvidence, TechnologyEvidenceRow,
    OntologyRow, ParityRunRow,
} from './types/techgraph.js';
export { CONFIDENCE_BY_LAYER } from './types/techgraph.js';
export type { CandidateUpsertInput } from './implementations/TechnologyCandidateRepository.js';

// Ontology import (Tier 2 importer)
export type {
    RawImportEntry, OntologyCategory, CategorizationResult, ImportRunCounts,
} from './types/ontology-import.js';
export { ONTOLOGY_CATEGORIES } from './types/ontology-import.js';
export { OntologyImportRunRepository }    from './implementations/OntologyImportRunRepository.js';
export { OntologyImportSourceRepository } from './implementations/OntologyImportSourceRepository.js';
export { OntologyWriteRepository }        from './implementations/OntologyWriteRepository.js';
