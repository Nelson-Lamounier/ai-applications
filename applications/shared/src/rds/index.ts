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
 *
 * IngestionPipeline itself lives in applications/ingestion/src/knowledge/ —
 * this barrel only exports the interfaces/helpers it consumes.
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
    RetrievalPrefilter,
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
export { RdsExperienceVectorStore }  from './implementations/RdsExperienceVectorStore.js';
export { RdsSyncStateRepository }    from './implementations/RdsSyncStateRepository.js';
export { TitanEmbeddingProvider }    from './implementations/TitanEmbeddingProvider.js';
export type { TitanCostContext }     from './implementations/TitanEmbeddingProvider.js';
export { BedrockChunkEnricher }      from './implementations/BedrockChunkEnricher.js';
export type { BedrockChunkEnricherConfig } from './implementations/BedrockChunkEnricher.js';

// Runtime credential hydration — SSM host + Secrets Manager password
export { hydrateRdsEnv }             from './hydrate-rds-env.js';

// Quality
export { computeKbQuality } from './quality/computeKbQuality.js';
export type {
    KbQualityFactor,
    KbQualityBreakdown,
    KbQualityResult,
    KbQualityInput,
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

export { RdsRepoActivityStore } from './implementations/RdsRepoActivityStore.js';
export { RdsRepoFileStateRepository } from './implementations/RdsRepoFileStateRepository.js';

// Rename self-heal — re-stamp the denormalised repo_full_name label everywhere
// from the immutable github_repo_id (twin of the admin-api reconcile).
export { reconcileRepoName } from './reconcileRepoName.js';

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
export { SkillEmbeddingResolver, DEFAULT_SKILL_MATCH_THRESHOLD } from './ontology/SkillEmbeddingResolver.js';
export type { SkillMatch } from './ontology/SkillEmbeddingResolver.js';
export { PhraseSkillResolver } from './ontology/PhraseSkillResolver.js';
export { canonicaliseSkills } from './ontology/canonicaliseSkills.js';
export { RdsOntologyGapRecorder, NullOntologyGapRecorder } from './ontology/OntologyGapRecorder.js';
export type { IOntologyGapRecorder, OntologyGap, OntologyGapContext } from './ontology/OntologyGapRecorder.js';
export { dedupeSkillCanonicals } from './ontology/dedupeSkillCanonicals.js';
export type { DedupCandidate, DedupAction, DedupOptions } from './ontology/dedupeSkillCanonicals.js';
export { groupChunksByFile } from './enrichment/groupChunksByFile.js';
export type { FileEnrichUnit } from './enrichment/groupChunksByFile.js';
export { assignSkillsToChunks } from './enrichment/assignSkillsToChunks.js';
export type { SkillAssignment, SkillEvidence } from './enrichment/assignSkillsToChunks.js';
export { tier1SkillsFromTech } from './enrichment/tier1-skill-rules.js';
export { TechSkillMapRepository } from './implementations/TechSkillMapRepository.js';
export { packChunks } from './enrichment/packChunks.js';
export type { PackItem, ChunkPack } from './enrichment/packChunks.js';
export { buildCanonicalExtractionBody, parseCanonicalSkills } from './implementations/canonicalVocabExtraction.js';
export type { CanonicalSplit } from './implementations/canonicalVocabExtraction.js';
export { SkillOntologyWriteRepository } from './implementations/SkillOntologyWriteRepository.js';
export { scoreSkillResolution } from './ontology/evaluateSkillResolution.js';
export type { ResolutionOutcome, ResolutionScore } from './ontology/evaluateSkillResolution.js';
export { backfillSkillEmbeddings } from './ontology/backfillSkillEmbeddings.js';
export type { BackfillSkillEmbeddingsOptions } from './ontology/backfillSkillEmbeddings.js';
export { TechnologyOntologyRepository }     from './implementations/TechnologyOntologyRepository.js';
export { SkillOntologyRepository }          from './implementations/SkillOntologyRepository.js';
export { TechnologyEvidenceRepository }     from './implementations/TechnologyEvidenceRepository.js';
export { TechnologyCandidateRepository }    from './implementations/TechnologyCandidateRepository.js';
export { TechnologyParityRunRepository }    from './implementations/TechnologyParityRunRepository.js';
export { ArticleTopicCandidateRepository }  from './implementations/ArticleTopicCandidateRepository.js';
export type {
    ArticleTopicCandidate,
    ArticleTopicCandidateInput,
    ArticleTopicCandidateStatus,
    VerifiedMetric,
    EvidenceRef,
} from './implementations/ArticleTopicCandidateRepository.js';
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
export { OntologyReviewQueueRepository }    from './implementations/OntologyReviewQueueRepository.js';
export type { OntologyReviewQueueInput }    from './implementations/OntologyReviewQueueRepository.js';
export { OntologySkippedImportRepository }  from './implementations/OntologySkippedImportRepository.js';
export type { OntologySkippedImportInput }  from './implementations/OntologySkippedImportRepository.js';

export { resolvePortfolioOwnerId } from './portfolioOwner.js';
