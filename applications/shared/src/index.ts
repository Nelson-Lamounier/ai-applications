/**
 * @format
 * Shared Module — Barrel Export
 *
 * Single entry point for all shared utilities, types, and metrics
 * used by the article pipeline, self-healing, and chatbot agents.
 *
 * Consumers import from this barrel rather than reaching into
 * individual files, keeping import paths shallow and manageable.
 *
 * @example
 * ```typescript
 * import { runAgent, parseJsonResponse } from '@bedrock/shared';
 * import type { AgentConfig, PipelineContext } from '@bedrock/shared';
 * ```
 */

// ─── Agent Runner ────────────────────────────────────────────────────────────
export {
    runAgent,
    parseJsonResponse,
    AgentExecutionError,
} from './agent-runner.js';

export type { RunAgentOptions } from './agent-runner.js';

// ─── Base Agent Class ────────────────────────────────────────────────────────
export { BaseAgent } from './base-agent.js';

export type { BasePipelineContext } from './base-agent.js';

// ─── Observability (K8s + Lambda) ────────────────────────────────────────────
// Lazily-loaded so Lambdas don't pay for K8s-only deps (prom-client, pino,
// pyroscope) and K8s pods don't ship Lambda-only helpers unused.
export {
    bootstrapK8sObservability,
    pushFinalMetrics,
    jobLogger,
    activeTraceContext,
    withSpan,
    captureAwsClient,
    recordBedrockUsage,
    setBedrockMetricsRegistry,
} from './observability/index.js';

export type {
    ObservabilityHandle,
    BootstrapOptions,
    JobLogger,
    BedrockUsage,
    RecordBedrockUsageArgs,
} from './observability/index.js';

// ─── Metrics & Cost Estimation ───────────────────────────────────────────────
export {
    estimateInvocationCost,
    StageTimer,
    emitPipelineMetrics,
    emitFailureMetrics,
} from './metrics.js';

export type {
    TokenUsage,
    PipelineMetricsContext,
    StageDurations,
    FailureMetricsContext,
    FailureStage,
} from './metrics.js';

// ─── Types ───────────────────────────────────────────────────────────────────
export type {
    // Pipeline context
    ArticleStatus,
    PipelineMode,
    ComplexityTier,
    PipelineContext,

    // Agent configuration
    AgentName,
    AgentConfig,
    AgentResult,

    // Research Agent
    ComplexitySignals,
    ComplexityAnalysis,
    KbPassage,
    OutlineSection,
    ResearchResult,

    // SEO
    SuggestedReference,
    SeoResearch,

    // Writer Agent
    ShotListItem,
    ArticleMetadata,
    WriterResult,

    // QA Agent
    IssueSeverity,
    QaRecommendation,
    QaIssue,
    DimensionResult,
    QaValidationResult,

    // Article versioning
    ArticleVersionRecord,

    // Step Functions state shapes
    ResearchHandlerInput,
    WriterHandlerInput,
    QaHandlerInput,
    PipelineOutput,
} from './types.js';

// ─── Structured Logger ───────────────────────────────────────────────────────
export { log, createLogger } from './logger.js';

export type { LogLevel, LogFunction } from './logger.js';

// ─── EMF Metric Emission ─────────────────────────────────────────────────────
export { emitEmfMetric } from './emf.js';

// ─── MCP HTTP Client ─────────────────────────────────────────────────────────
export { callMcpTool } from './mcp-client.js';

export type { EmfMetricEntry } from './emf.js';

// ─── Strategist Pipeline Types ───────────────────────────────────────────────
export type {
    // Domain types
    InterviewStage,
    ApplicationStatus,
    FitRating,
    ApplicationRecommendation,
    SkillDepth,
    GapType,
    GapSeverity,

    // Structured Resume Data
    ResumeProfile,
    ResumeExperience,
    ResumeSkillCategory,
    ResumeEducation,
    ResumeCertification,
    ResumeProject,
    ResumeAchievement,
    StructuredResumeData,

    // Pipeline operation & context
    PipelineOperation,
    StrategistPipelineContext,

    // Research Agent
    VerifiedMatch,
    PartialMatch,
    SkillGap,
    JobRequirement,
    TechnologyInventory,
    ExperienceSignals,
    JdSignal,
    JdDimensionMix,
    ResearchMatching,
    StrategistResearchResult,
    KbRetrievalStats,
    KbRetrievalSource,

    // Skill Evidence Ledger
    EvidenceStatus,
    SkillEvidenceEntry,

    // Phase 0 Archetype Selection
    ArchetypeId,
    RoleArchetypeSelection,

    // Cover letter
    CoverLetterSignoff,
    CoverLetter,

    // Strategist Agent
    ResumeAdditionSuggestion,
    ResumeReframeSuggestion,
    ResumeEslCorrection,
    ResumeSuggestions,
    StrategistAnalysisResult,

    // Interview Coach
    InterviewQuestion,
    DifficultQuestion,
    TechnicalPrepItem,
    QuestionToAsk,
    CoachingSection,
    PhoneScreenTalkingPoint,
    InterviewCoachResult,

    // DynamoDB Entity
    JobApplicationRecord,

    // Step Functions state shapes — Analysis Pipeline
    StrategistResearchHandlerInput,
    StrategistWriterHandlerInput,
    ResumeBuilderHandlerInput,
    ResumeBuilderHandlerOutput,
    StrategistAnalysisPersistInput,
    StrategistAnalysisPipelineOutput,

    // Resume Builder Agent (Phase 4b)
    TailoredResumeResult,

    // Step Functions state shapes — Coaching Pipeline
    StrategistCoachLoaderInput,
    StrategistCoachHandlerInput,
    StrategistCoachPipelineOutput,

    // Union output
    StrategistPipelineOutput,
} from './strategist-types.js';

// ─── Ingestion (Repo → Vector Store Pipeline) ────────────────────────────────
export { GitHubAdapter }            from './ingestion/implementations/GitHubAdapter.js';
export type { GitHubRepoMeta }      from './ingestion/implementations/GitHubAdapter.js';
export { FileFilter, DEFAULT_FILTER_CONFIG } from './ingestion/implementations/FileFilter.js';
export { ChunkerRegistry }          from './ingestion/implementations/ChunkerRegistry.js';
export { CommitChunker, isoWeek }   from './ingestion/implementations/CommitChunker.js';
export { RepoIngestionOrchestrator } from './ingestion/orchestrator/RepoIngestionOrchestrator.js';

export type { FileFilterConfig }    from './ingestion/implementations/FileFilter.js';
export type { CommitChunkerConfig } from './ingestion/implementations/CommitChunker.js';
export type { OrchestratorOptions } from './ingestion/orchestrator/RepoIngestionOrchestrator.js';
export type {
    IRepoAdapter,
    RepoFile,
    RepoCommit,
    RepoPullRequest,
    ListCommitsOptions,
    ListPullRequestsOptions,
} from './ingestion/interfaces/IRepoAdapter.js';
export type { IFileFilter }         from './ingestion/interfaces/IFileFilter.js';
export type { IChunker }            from './ingestion/interfaces/IChunker.js';

// ─── RDS pgvector (Vector Store) ─────────────────────────────────────────────
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
    IVectorStore,
    ISyncStateRepository,
    IEmbeddingProvider,
    IChunkEnricher,
    ChunkEnrichment,
    RdsClientConfig,
    BedrockChunkEnricherConfig,
    IngestionPipelineOptions,
    KbQualityFactor,
    KbQualityBreakdown,
    KbQualityResult,
    IRetrievalProbe,
    RetrievalProbeArgs,
    RetrievalBreakdown,
    RetrievalQuestionResult,
    RetrievalStatus,
    RankCandidate,
    ProfileAggInput,
    LanguageStat,
    TechStat,
    ActivityArcEntry,
    UserProfileRollup,
    UserProfileRollupResult,
    IUserProfileRollupRepository,
    MirrorJson,
    RevealJson,
    ArchetypeFit,
    SeniorityCall,
    DirectionJson,
    UnsupportedClaim,
    UndersoldStrength,
    ReconciliationJson,
    DiagnosticJson,
    RollupRow,
    ICareerHistoryReadRepository,
    ResumeForReconciliation,
    ResumeSkillGroup,
    ResumeExperienceEntry,
    ResumeProjectEntry,
    IDiagnosticInputsReadRepository,
    DiagnosticInputs,
    KbStats,
    ResumeEntryCounts,
    ComponentKey,
    ComponentSubScore,
    DiagnosticComputed,
    DiagnosticComputeInput,
} from './rds/index.js';

export {
    RdsVectorStore,
    RdsExperienceVectorStore,
    RdsSyncStateRepository,
    TitanEmbeddingProvider,
    BedrockChunkEnricher,
    IngestionPipeline,
    computeKbQuality,
    sampleChunks,
    matchRank,
    scoreRetrieval,
    buildRetrievalSuggestions,
    recordBedrockCost,
    computeCostCents,
    recordInvocationToRds,
    computeUserProfileRollup,
    RdsUserProfileRollupRepository,
    RdsCareerHistoryReadRepository,
    RdsDiagnosticInputsReadRepository,
    computeUserDiagnostic,
    WEIGHTS,
    KB_SCORE_THRESHOLD,
    RdsOAuthConnectionsRepository,
    RdsRepoActivityStore,
    RdsRepoFileStateRepository,
} from './rds/index.js';

export type { CostRecord, TitanCostContext } from './rds/index.js';
export type {
    IOAuthConnectionsRepository,
    OAuthConnection,
    NewOAuthConnection,
} from './rds/index.js';

// Technology graph (Layer 1)
export { OntologyResolver, normalizeAlias } from './rds/index.js';
export { TechnologyOntologyRepository }     from './rds/index.js';
export { TechnologyEvidenceRepository }     from './rds/index.js';
export { TechnologyCandidateRepository }    from './rds/index.js';
export { TechnologyParityRunRepository }    from './rds/index.js';
export { CONFIDENCE_BY_LAYER }             from './rds/index.js';
export type {
    SourceLayer, RawTechnologyEvidence, TechnologyEvidenceRow,
    OntologyRow, ParityRunRow, CandidateUpsertInput,
} from './rds/index.js';

// Ontology import (Tier 2 importer)
export type {
    RawImportEntry, OntologyCategory, CategorizationResult, ImportRunCounts,
} from './rds/index.js';
export { ONTOLOGY_CATEGORIES } from './rds/index.js';
export { OntologyImportRunRepository }    from './rds/index.js';
export { OntologyImportSourceRepository } from './rds/index.js';
export { OntologyWriteRepository }        from './rds/index.js';
export { OntologyReviewQueueRepository }   from './rds/index.js';
export { OntologySkippedImportRepository } from './rds/index.js';
export type {
    OntologyReviewQueueInput,
    OntologySkippedImportInput,
} from './rds/index.js';

// ─── Crypto (KMS Envelope Encryption) ────────────────────────────────────────
export { createKmsEnvelope, KmsEnvelopeError } from './crypto/index.js';
export type { KmsEnvelope, EncryptedPayload } from './crypto/index.js';

// ─── GitHub App Helpers ──────────────────────────────────────────────────────
export { signGitHubAppJwt, GitHubAppJwtError, verifyWebhookSignature } from './github/index.js';
export type { AppJwtOptions } from './github/index.js';

// ─── Retrieval (Reranking + pgvector) ────────────────────────────────────────
export type {
    IReranker,
    RerankCandidate,
    RerankResult,
    RerankOptions,
    BedrockRerankerConfig,
    RetrievedPassage,
    RetrieveOptions,
} from './retrieval/index.js';

export { BedrockReranker, PgVectorRetriever } from './retrieval/index.js';

// ─── Security (Input/Output Sanitisation + PII Scrubbing) ────────────────────
// Single source of truth — re-export the security barrel rather than
// re-listing every symbol (kept these two lists in lockstep otherwise).
export * from './security/index.js';

// ─── Chatbot utilities ────────────────────────────────────────────────────────
export { buildChatContext, expandQuery, CHATBOT_SYSTEM_PROMPT, recordZeroResultRetrieval } from './chatbot/index.js';
export type { Metric, ChatbotResponse, ZeroResultRetrievalParams } from './chatbot/index.js';

// ─── Grounding (Answer Self-Correction / Verification) ───────────────────────
export { BedrockGroundingVerifier, DEFAULT_GROUNDING_FALLBACK } from './grounding/index.js';
export type {
    BedrockGroundingVerifierConfig,
    GroundingInput,
    GroundingMode,
    GroundingResult,
    IGroundingVerifier,
} from './grounding/index.js';

// ─── Prose Quality (stop-slop linter, flag mode) ─────────────────────────────
export {
    BedrockProseLinter,
    PROSE_PASS_THRESHOLD,
    normalizeProse,
} from './prose-quality/index.js';
export type {
    BedrockProseLinterConfig,
    ProseLinterCostContext,
    IProseLinter,
    ProseIssue,
    ProseLinterMode,
    ProseQualityInput,
    ProseQualityResult,
    ProseRegister,
    ProseScore,
    ProseSection,
} from './prose-quality/index.js';

// ─── Cache (Semantic Response Cache + Redis Read Cache) ──────────────────────
export { PgSemanticCache } from './cache/index.js';
export { RedisExactCache } from './cache/index.js';
export type {
    ISemanticCache,
    SemanticCacheConfig,
    SemanticCacheGetInput,
    SemanticCacheGetResult,
    SemanticCachePutInput,
    SemanticCacheInvalidateInput,
    RedisExactCacheOptions,
} from './cache/index.js';

export {
    RedisReadCache,
    resolveRedisCacheConfig,
    createRedisCacheClient,
    projectCaseStudyKey,
} from './cache/index.js';
export type { RedisCacheConfig, RedisLike, CacheMetrics } from './cache/index.js';

// ─── Feature Flags (app_config-backed) ───────────────────────────────────────
export {
    isFeatureEnabled,
    clearFeatureFlagCache,
    upsertFeatureFlag,
} from './config/feature-flags.js';

// ─── Projects domain (multi-repo case-study) ─────────────────────────────────
export {
    PROJECT_COMPONENT_KINDS,
    ProjectComponentKindSchema,
    ClusteringComponentSchema,
    ClusteringProposalSchema,
    ClusteringResultSchema,
    buildClusteringSignals,
    extractNamingPrefixes,
    extractSharedTechStack,
    extractSharedTopics,
    extractEmbeddingPairs,
    serialiseSignalsForPrompt,
    bedrockClusteringAgent,
    loadRepoDigests,
    loadDescriptionEmbeddings,
    persistClusteringResult,
    runClusteringOrchestration,
    // Case study (Phase 2B)
    SourceSignalSchema,
    CaseStudySchema,
    PROJECT_TYPES,
    PROJECT_STATUS,
    RESUME_BULLET_ANGLES,
    STACK_CATEGORIES,
    TEST_COVERAGE_SIGNALS,
    CI_MATURITY,
    DOC_DENSITY,
    computeContentHash,
    mergeGroundingResult,
    flattenSignalToContext,
    bedrockCaseStudyAgent,
    loadCaseStudyContext,
    persistCaseStudy,
    runCaseStudyOrchestration,
    // System tour (S7)
    SystemTourSchema,
    bedrockSystemTourAgent,
    buildSystemTourSystemPrompt,
    parseSystemTourResponse,
    RdsSystemTourRepository,
    runSystemTour,
    computeCaseStudyHash,
} from './projects/index.js';
export type {
    ProjectComponentKind,
    ClusteringComponent,
    ClusteringProposal,
    ClusteringResult,
    ClusteringSignals,
    RepoClusteringDigest,
    DescriptionEmbedding,
    ClusteringAgent,
    PersistClusteringInput,
    PersistClusteringSummary,
    RunClusteringInput,
    RunClusteringOutput,
    // Case study (Phase 2B)
    SourceSignal,
    CaseStudy,
    CaseStudyContext,
    StackItem,
    Decision,
    Highlight,
    Challenge,
    ResumeBulletSet,
    DepthMarkers,
    Architecture,
    CaseStudyAgent,
    CaseStudyCommit,
    CaseStudyPullRequest,
    CommitLoader,
    PullRequestLoader,
    LoadCaseStudyContextResult,
    PersistCaseStudyInput,
    PersistCaseStudySummary,
    RunCaseStudyInput,
    RunCaseStudyOutput,
    // System tour (S7)
    SystemTour,
    SystemTourAgent,
    RunSystemTourInput,
    RunSystemTourOutput,
    SystemTourAgentLike,
    SystemTourCache,
} from './projects/index.js';
export * from './stage-prep/index.js';
export { RdsStagePrepOntologyRepository } from './rds/implementations/RdsStagePrepOntologyRepository.js';
export { RdsSystemDesignConcernRepository } from './rds/implementations/RdsSystemDesignConcernRepository.js';

// ─── Role Ontology ────────────────────────────────────────────────────────────
export { RoleOntologyRepository } from './rds/implementations/RoleOntologyRepository.js';
export type { RoleFamily, RoleClass, RoleCandidateType, RoleLearningCandidate, NewFamily, CompanyType } from './rds/types/role-ontology.js';
