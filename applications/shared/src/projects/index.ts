/**
 * @format
 * Barrel for the Projects multi-repo domain helpers — clustering today,
 * case-study generation in a follow-on PR.
 */
export {
    PROJECT_COMPONENT_KINDS,
    ProjectComponentKindSchema,
    ClusteringComponentSchema,
    ClusteringProposalSchema,
    ClusteringResultSchema,
} from './types.js';
export type {
    ProjectComponentKind,
    ClusteringComponent,
    ClusteringProposal,
    ClusteringResult,
    ClusteringSignals,
    RepoClusteringDigest,
} from './types.js';

export {
    buildClusteringSignals,
    extractNamingPrefixes,
    extractSharedTechStack,
    extractSharedTopics,
    extractEmbeddingPairs,
    serialiseSignalsForPrompt,
} from './clustering/clustering-signals.js';
export type { DescriptionEmbedding } from './clustering/clustering-signals.js';

export {
    bedrockClusteringAgent,
} from './clustering/clustering-agent.js';
export type { ClusteringAgent } from './clustering/clustering-agent.js';

export {
    loadRepoDigests,
    loadDescriptionEmbeddings,
} from './clustering/clustering-loader.js';

export {
    persistClusteringResult,
} from './clustering/clustering-persistence.js';
export type {
    PersistClusteringInput,
    PersistClusteringSummary,
} from './clustering/clustering-persistence.js';

export {
    runClusteringOrchestration,
} from './clustering/clustering-orchestrator.js';
export type {
    RunClusteringInput,
    RunClusteringOutput,
} from './clustering/clustering-orchestrator.js';

// Code-grounded component kinds (replaces md-based LLM guessing of repo role).
export { classifyComponentKind, componentNameFor } from './grounding/component-kind.js';
export type { RepoRoleSignals } from './grounding/component-kind.js';
export { regroupComponentsByKind, applyGroundedComponentKinds } from './grounding/grounded-components.js';
export { loadRepoRoleSignals, extractRoleSignals } from './grounding/repo-role-signals.js';
export { recomputeConfirmedProjectComponents } from './grounding/confirmed-project-refresh.js';
export type { ConfirmedRefreshSummary } from './grounding/confirmed-project-refresh.js';

// ─── Case study (Phase 2B) ──────────────────────────────────────────────────
export {
    SourceSignalSchema,
    CaseStudySchema,
    ArchitectureSchema,
    PROJECT_TYPES,
    PROJECT_STATUS,
    RESUME_BULLET_ANGLES,
    STACK_CATEGORIES,
    TEST_COVERAGE_SIGNALS,
    CI_MATURITY,
    DOC_DENSITY,
} from './case-study/case-study-types.js';
export type {
    SourceSignal,
    CaseStudy,
    PriorCaseStudy,
    CaseStudyContext,
    StackItem,
    Decision,
    Highlight,
    Challenge,
    ResumeBulletSet,
    DepthMarkers,
    Architecture,
} from './case-study/case-study-types.js';

export {
    computeContentHash,
    mergeGroundingResult,
    flattenSignalToContext,
} from './case-study/source-signals.js';

export { bedrockCaseStudyAgent } from './case-study/case-study-agent.js';
export type { CaseStudyAgent } from './case-study/case-study-agent.js';

export { loadCaseStudyContext } from './case-study/case-study-loader.js';
export type {
    CaseStudyCommit,
    CaseStudyPullRequest,
    CommitLoader,
    PullRequestLoader,
    LoadCaseStudyContextResult,
} from './case-study/case-study-loader.js';

export { persistCaseStudy } from './case-study/case-study-persistence.js';
export type {
    PersistCaseStudyInput,
    PersistCaseStudySummary,
} from './case-study/case-study-persistence.js';

export { runCaseStudyOrchestration } from './case-study/case-study-orchestrator.js';
export type {
    RunCaseStudyInput,
    RunCaseStudyOutput,
} from './case-study/case-study-orchestrator.js';

export { reconstructPriorCaseStudy, underrepresentedRepos, scopeEvidenceToRepos } from './case-study/case-study-refine.js';
export { deriveArticleCandidates, buildCandidatesFromCaseStudy } from './case-study/article-topic-discovery.js';
export type { DiscoverySource, DeriveCandidatesInput } from './case-study/article-topic-discovery.js';
export {
    runRefineGraders,
    gradeNewRepoCoverage,
    gradeNoDuplicates,
    gradeCaps,
    gradePriorContinuity,
} from './case-study/case-study-refine-grader.js';
export type {
    RefineGradeInput,
    RefineGradeResult,
    RefineGradeReport,
} from './case-study/case-study-refine-grader.js';

// ─── System tour (S7a) ──────────────────────────────────────────────────────
export { SystemTourSchema } from './system-tour/system-tour-types.js';
export type {
    SystemTour,
    KeyDecision,
    Tradeoff,
} from './system-tour/system-tour-types.js';

export {
    bedrockSystemTourAgent,
    buildSystemTourSystemPrompt,
    parseSystemTourResponse,
    SYSTEM_TOUR_TOOL,
} from './system-tour/system-tour-agent.js';
export type { SystemTourAgent } from './system-tour/system-tour-agent.js';

export { RdsSystemTourRepository } from './system-tour/system-tour-persistence.js';

export {
    runSystemTour,
    computeCaseStudyHash,
    semanticTourCache,
} from './system-tour/system-tour-orchestrator.js';
export type {
    RunSystemTourInput,
    RunSystemTourOutput,
    SystemTourAgentLike,
    SystemTourCache,
} from './system-tour/system-tour-orchestrator.js';

export { stampUserEvidenceMetadata } from './evidence/apply-evidence-stamp.js';
export { buildEvidenceStamp } from './evidence/evidence-metadata-stamp.js';
export type { EvidenceStamp, RepoSignals } from './evidence/evidence-metadata-stamp.js';

// Grounded change-impact (commit diffs → deterministic facts → measured % → gated narration).
export {
    summariseCommitChange,
    cyclomaticComplexityDelta,
    buildFileChangeImpact,
    percentChange,
    buildChangeImpactReport,
} from './change-impact/change-metrics.js';
export type {
    CommitChangeMetrics,
    FileChangeImpact,
    PerfComparison,
    ChangeImpactReport,
} from './change-impact/change-metrics.js';
export { allowedNumbersFor, findUngroundedNumbers, isGrounded } from './change-impact/change-impact-grounding.js';
export { narrateChangeImpact, buildDeterministicNarration } from './change-impact/change-impact-narrator.js';
export type { ChangeImpactNarration } from './change-impact/change-impact-narrator.js';
export { narrateFileChangeImpact } from './change-impact/change-impact-service.js';
export type { ChangeImpactStore, FileChangeImpactResult } from './change-impact/change-impact-service.js';

export { deriveDepthMarkers } from './case-study/case-study-depth.js';
export type { DepthSignals } from './case-study/case-study-depth.js';

// ─── Repo evidence signals + archetype ontology ────────────────────────────
// Previously reached by deep relative imports (ingestion orchestrator, rds
// ontology repository); exported here so the barrel is the complete interface.
export { deriveRepoSignals, REPO_SIGNAL_KEYS } from './evidence/repo-signals.js';
export type { RepoFileEntry, DeriveRepoSignalsOptions, RepoSignalKey } from './evidence/repo-signals.js';
export { deriveEvidenceTopology } from './evidence/evidence-topology.js';
export type { EvidenceTopology } from './evidence/evidence-topology.js';
export { ARCHETYPE_IDS, STAGE_IDS } from './archetype/archetype-types.js';
export type {
    ArchetypeId,
    StageId,
    ArchetypeDef,
    StageOverlay,
    ClassificationSignals,
} from './archetype/archetype-types.js';
