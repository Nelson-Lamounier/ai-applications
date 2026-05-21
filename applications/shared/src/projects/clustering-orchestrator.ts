/**
 * @format
 * Compose the clustering loaders, signal extractor, agent, and persistence
 * into one entrypoint reusable by:
 *
 *   - the K8s Job (`applications/job-strategist/src/run-clustering.ts`)
 *   - the E2E test (`scripts/test-projects-clustering.ts`)
 *
 * The K8s entrypoint is responsible for env parsing, pool lifecycle,
 * pipeline_runs state updates, and metrics — all things this function
 * intentionally does NOT do, so it stays unit-testable against an
 * injected agent.
 */
import type { Pool } from 'pg';

import type { BasePipelineContext } from '../base-agent.js';

import type { ClusteringAgent } from './clustering-agent.js';
import {
    loadDescriptionEmbeddings,
    loadRepoDigests,
} from './clustering-loader.js';
import {
    persistClusteringResult,
    type PersistClusteringSummary,
} from './clustering-persistence.js';
import { buildClusteringSignals } from './clustering-signals.js';
import type { ClusteringResult, RepoClusteringDigest } from './types.js';

export interface RunClusteringInput {
    readonly userId:        string;
    readonly pipelineRunId: string;
    readonly agent:         ClusteringAgent;
    readonly ctx:           BasePipelineContext;
}

export interface RunClusteringOutput {
    readonly digests:    readonly RepoClusteringDigest[];
    readonly result:     ClusteringResult;
    readonly persisted:  PersistClusteringSummary;
}

/**
 * Orchestrate one clustering run end-to-end inside a single pg `Pool`.
 *
 *   1. Load digests + embeddings (pool, read-only).
 *   2. Build signals (pure functions).
 *   3. Invoke the injected `agent` to produce a ClusteringResult.
 *   4. Persist via the dedicated transactional writer.
 *
 * If fewer than two repos are loaded, the function short-circuits with an
 * empty result — clustering doesn't make sense for solo users.
 */
export async function runClusteringOrchestration(
    pool: Pool,
    input: RunClusteringInput,
): Promise<RunClusteringOutput> {
    const digests = await loadRepoDigests(pool, input.userId);
    if (digests.length < 2) {
        return {
            digests,
            result: { proposals: [] },
            persisted: {
                proposalsInserted: 0,
                componentsInserted: 0,
                linksInserted: 0,
                proposalsSkipped: 0,
                priorProposalsCleared: 0,
            },
        };
    }

    const embeddings = await loadDescriptionEmbeddings(pool, input.userId);
    const signals    = buildClusteringSignals(digests, embeddings);

    const { data: result } = await input.agent.invoke(digests, signals, input.ctx);

    const client = await pool.connect();
    let persisted: PersistClusteringSummary;
    try {
        persisted = await persistClusteringResult(client, {
            userId:        input.userId,
            pipelineRunId: input.pipelineRunId,
            result,
        });
    } finally {
        client.release();
    }

    return { digests, result, persisted };
}
