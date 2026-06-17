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
} from './clustering-signals.js';
export type { DescriptionEmbedding } from './clustering-signals.js';

export {
    bedrockClusteringAgent,
} from './clustering-agent.js';
export type { ClusteringAgent } from './clustering-agent.js';

export {
    loadRepoDigests,
    loadDescriptionEmbeddings,
} from './clustering-loader.js';

export {
    persistClusteringResult,
} from './clustering-persistence.js';
export type {
    PersistClusteringInput,
    PersistClusteringSummary,
} from './clustering-persistence.js';

export {
    runClusteringOrchestration,
} from './clustering-orchestrator.js';
export type {
    RunClusteringInput,
    RunClusteringOutput,
} from './clustering-orchestrator.js';

// Code-grounded component kinds (replaces md-based LLM guessing of repo role).
export { classifyComponentKind, componentNameFor } from './component-kind.js';
export type { RepoRoleSignals } from './component-kind.js';
export { regroupComponentsByKind, applyGroundedComponentKinds } from './grounded-components.js';
export { loadRepoRoleSignals, extractRoleSignals } from './repo-role-signals.js';
export { recomputeConfirmedProjectComponents } from './confirmed-project-refresh.js';
export type { ConfirmedRefreshSummary } from './confirmed-project-refresh.js';

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
} from './case-study-types.js';
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
} from './case-study-types.js';

export {
    computeContentHash,
    mergeGroundingResult,
    flattenSignalToContext,
} from './source-signals.js';

export { bedrockCaseStudyAgent } from './case-study-agent.js';
export type { CaseStudyAgent } from './case-study-agent.js';

export { loadCaseStudyContext } from './case-study-loader.js';
export type {
    CaseStudyCommit,
    CaseStudyPullRequest,
    CommitLoader,
    PullRequestLoader,
    LoadCaseStudyContextResult,
} from './case-study-loader.js';

export { persistCaseStudy } from './case-study-persistence.js';
export type {
    PersistCaseStudyInput,
    PersistCaseStudySummary,
} from './case-study-persistence.js';

export { runCaseStudyOrchestration } from './case-study-orchestrator.js';
export type {
    RunCaseStudyInput,
    RunCaseStudyOutput,
} from './case-study-orchestrator.js';

export { reconstructPriorCaseStudy, underrepresentedRepos, scopeEvidenceToRepos } from './case-study-refine.js';
export {
    runRefineGraders,
    gradeNewRepoCoverage,
    gradeNoDuplicates,
    gradeCaps,
    gradePriorContinuity,
} from './case-study-refine-grader.js';
export type {
    RefineGradeInput,
    RefineGradeResult,
    RefineGradeReport,
} from './case-study-refine-grader.js';

// ─── System tour (S7a) ──────────────────────────────────────────────────────
export { SystemTourSchema } from './system-tour-types.js';
export type {
    SystemTour,
    KeyDecision,
    Tradeoff,
} from './system-tour-types.js';

export {
    bedrockSystemTourAgent,
    buildSystemTourSystemPrompt,
    parseSystemTourResponse,
    SYSTEM_TOUR_TOOL,
} from './system-tour-agent.js';
export type { SystemTourAgent } from './system-tour-agent.js';

export { RdsSystemTourRepository } from './system-tour-persistence.js';

export {
    runSystemTour,
    computeCaseStudyHash,
} from './system-tour-orchestrator.js';
export type {
    RunSystemTourInput,
    RunSystemTourOutput,
    SystemTourAgentLike,
    SystemTourCache,
} from './system-tour-orchestrator.js';

export { stampUserEvidenceMetadata } from './stamp-evidence-metadata.js';
export { buildEvidenceStamp } from './evidence-metadata-stamp.js';
export type { EvidenceStamp, RepoSignals } from './evidence-metadata-stamp.js';

// Grounded change-impact (commit diffs → deterministic facts → measured % → gated narration).
export {
    summariseCommitChange,
    cyclomaticComplexityDelta,
    buildFileChangeImpact,
    percentChange,
    buildChangeImpactReport,
} from './change-metrics.js';
export type {
    CommitChangeMetrics,
    FileChangeImpact,
    PerfComparison,
    ChangeImpactReport,
} from './change-metrics.js';
export { allowedNumbersFor, findUngroundedNumbers, isGrounded } from './change-impact-grounding.js';
export { narrateChangeImpact, buildDeterministicNarration } from './change-impact-narrator.js';
export type { ChangeImpactNarration } from './change-impact-narrator.js';
export { narrateFileChangeImpact } from './change-impact-service.js';
export type { ChangeImpactStore, FileChangeImpactResult } from './change-impact-service.js';
