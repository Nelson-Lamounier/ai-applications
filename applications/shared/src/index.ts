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
    activeTraceContext,
    withSpan,
    recordBedrockUsage,
    setBedrockMetricsRegistry,
} from './observability/index.js';

export type {
    ObservabilityHandle,
    BootstrapOptions,
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
    StrategistResearchResult,

    // Phase 0 Archetype Selection
    ArchetypeId,
    RoleArchetypeSelection,

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
    ListCommitsOptions,
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
} from './rds/index.js';

export {
    RdsVectorStore,
    RdsSyncStateRepository,
    TitanEmbeddingProvider,
    BedrockChunkEnricher,
    IngestionPipeline,
    computeKbQuality,
    recordBedrockCost,
    computeCostCents,
} from './rds/index.js';

export type { CostRecord, TitanCostContext } from './rds/index.js';

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
export { InputSanitiser, InputSanitisationError } from './security/input-sanitiser.js';
export type { InputSanitiserConfig } from './security/input-sanitiser.js';
export { OutputSanitiser } from './security/output-sanitiser.js';
export type { OutputSanitiserConfig } from './security/output-sanitiser.js';
export type {
    InputPattern,
    OutputRedactionRule,
    PiiPattern,
    SanitiseInputResult,
    SanitisationResult,
} from './security/types.js';
export { PiiScrubber } from './security/pii-scrubber.js';
export type { PiiScrubberConfig, PiiScrubResult } from './security/pii-scrubber.js';
export { RegexPiiDetector } from './security/regex-pii-detector.js';
export { ComprehendPiiDetector } from './security/comprehend-pii-detector.js';
export { DEFAULT_REDACTION_POLICY } from './security/pii-types.js';
export type { IPiiDetector, PiiSpan, PiiType, RedactionPolicy } from './security/pii-types.js';

// ─── Chatbot utilities ────────────────────────────────────────────────────────
export { buildChatContext, expandQuery, CHATBOT_SYSTEM_PROMPT } from './chatbot/index.js';
export type { Metric, ChatbotResponse } from './chatbot/index.js';

// ─── Grounding (Answer Self-Correction / Verification) ───────────────────────
export { BedrockGroundingVerifier, DEFAULT_GROUNDING_FALLBACK } from './grounding/index.js';
export type {
    BedrockGroundingVerifierConfig,
    GroundingInput,
    GroundingMode,
    GroundingResult,
    IGroundingVerifier,
} from './grounding/index.js';
