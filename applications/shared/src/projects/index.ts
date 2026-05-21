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
