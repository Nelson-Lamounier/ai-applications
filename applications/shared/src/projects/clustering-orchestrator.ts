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
import { createHash } from 'node:crypto';

import type { Pool } from 'pg';

import type { BasePipelineContext } from '../base-agent.js';
import type { ISemanticCache } from '../cache/cache-types.js';

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
import { ClusteringResultSchema } from './types.js';
import { loadRepoRoleSignals } from './repo-role-signals.js';
import { applyGroundedComponentKinds } from './grounded-components.js';
import type { ClusteringResult, ClusteringSignals, RepoClusteringDigest } from './types.js';

const CACHE_SCOPE_PREFIX = 'clustering';

/**
 * Stable hash over the exact inputs the clustering agent sees: the per-repo
 * digests (sorted by id) and the deterministic signal block. Identical
 * inputs hash identically so we can serve the prior result from the cache
 * instead of re-invoking Haiku.
 */
export function computeClusteringInputHash(
    digests: readonly RepoClusteringDigest[],
    signals: ClusteringSignals,
): string {
    const h = createHash('sha256');
    const sorted = [...digests].sort((a, b) => a.repositoryId.localeCompare(b.repositoryId));
    for (const d of sorted) {
        // NUL separators — cannot appear in repo/language/topic/classification
        // values, so distinct field splits can never produce the same stream.
        h.update(`${d.repositoryId}\0${d.fullName}\0${d.primaryLanguage ?? ''}\0`);
        h.update([...d.topics].sort().join(','));
        h.update('\0');
        h.update([...d.techStack].sort().join(','));
        h.update('\0');
        h.update(d.classification ?? '');
        h.update('\0');
    }
    const pairs = [...signals.embeddingPairs]
        .map((p) => `${p.repoA}|${p.repoB}|${p.score.toFixed(4)}`)
        .sort();
    for (const p of pairs) h.update(p);
    return h.digest('hex');
}

export interface RunClusteringInput {
    readonly userId:        string;
    readonly pipelineRunId: string;
    readonly agent:         ClusteringAgent;
    readonly ctx:           BasePipelineContext;
    readonly cache?:        ISemanticCache;
    readonly kbTag?:        string;
}

export interface RunClusteringOutput {
    readonly digests:    readonly RepoClusteringDigest[];
    readonly result:     ClusteringResult;
    readonly persisted:  PersistClusteringSummary;
    readonly cacheHit:   boolean;
    readonly inputHash:  string;
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
            cacheHit: false,
            inputHash: '',
        };
    }

    const embeddings = await loadDescriptionEmbeddings(pool, input.userId);
    const signals    = buildClusteringSignals(digests, embeddings);

    const inputHash  = computeClusteringInputHash(digests, signals);
    const cacheScope = `${CACHE_SCOPE_PREFIX}:${input.userId}`;
    const kbTag      = input.kbTag ?? 'default';

    // 1. Try the cache.
    let result: ClusteringResult | undefined;
    let cacheHit = false;
    if (input.cache) {
        try {
            const hit = await input.cache.get({ scope: cacheScope, kbTag, queryText: inputHash });
            if (hit.hit && hit.response) {
                const parsed = ClusteringResultSchema.safeParse(hit.response);
                if (parsed.success) {
                    result = parsed.data;
                    cacheHit = true;
                }
            }
        } catch {
            // Cache failures are non-fatal — fall through to a fresh run.
        }
    }

    // 2. Run the agent if the cache missed.
    if (!result) {
        const agentResult = await input.agent.invoke(digests, signals, input.ctx);
        result = agentResult.data;
    }

    // 2b. Override component kinds/names with code-grounded classification, so the
    // agent's md-influenced guesses (e.g. a GitOps-infra repo filed as 'shared')
    // can never persist. Idempotent — safe to apply to cached results too.
    const roleSignals = await loadRepoRoleSignals(pool, input.userId);
    result = applyGroundedComponentKinds(result, roleSignals);

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

    // 3. Update the cache. Fail-open — never throw on a cache put.
    if (input.cache && !cacheHit) {
        try {
            await input.cache.put({ scope: cacheScope, kbTag, queryText: inputHash, response: result });
        } catch {
            // ignore
        }
    }

    return { digests, result, persisted, cacheHit, inputHash };
}
