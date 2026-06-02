/**
 * @format
 * runSystemTour — lean orchestration for the per-project System Tour (S7a).
 *
 * Unlike the case-study orchestrator, the only input is an
 * already-generated, already-grounded `CaseStudy`; there is no context
 * loader and no grounding pass (the case study is the sole evidence and was
 * verified upstream). Sequence:
 *
 *   1. Compute a stable hash over the `caseStudy` — mirrors
 *      `computeInputHash` in `case-study-orchestrator.ts` (sha256 over the
 *      stable model inputs; here that is the whole case study, so we hash
 *      its canonical JSON serialisation).
 *   2. Optional cache lookup keyed by that hash. On a hit, short-circuit the
 *      agent (cacheHit = true).
 *   3. Otherwise invoke the system-tour agent; populate the cache if one was
 *      provided.
 *   4. Persist via `RdsSystemTourRepository.upsert`.
 *   5. Return `{ cacheHit, tour, inputHash }`.
 */
import { createHash } from 'node:crypto';

import type { BasePipelineContext } from '../base-agent.js';

import type { CaseStudy } from './case-study-types.js';
import type { SystemTour } from './system-tour-types.js';
import type { RdsSystemTourRepository } from './system-tour-persistence.js';

/**
 * The agent dependency, narrowed to what the orchestrator needs: an
 * `invoke(caseStudy, ctx)` returning `{ data: SystemTour }`. Matches
 * `SystemTourAgent` (whose `AgentResult<SystemTour>` carries `.data`).
 */
export interface SystemTourAgentLike {
    invoke(
        caseStudy: CaseStudy,
        ctx: BasePipelineContext,
    ): Promise<{ data: SystemTour }>;
}

/**
 * Minimal key/value cache contract for the tour. Keyed by the case-study
 * hash. Distinct from `ISemanticCache` — the tour key is already a stable,
 * deterministic hash, so no embedding/scope/kbTag machinery is needed.
 */
export interface SystemTourCache {
    get(hash: string): Promise<SystemTour | null | undefined>;
    set(hash: string, tour: SystemTour): Promise<void>;
}

export interface RunSystemTourInput {
    readonly projectId: string;
    readonly userId:    string;
    readonly caseStudy: CaseStudy;
    readonly agent:     SystemTourAgentLike;
    readonly repo:      RdsSystemTourRepository;
    readonly cache?:    SystemTourCache;
    readonly ctx:       BasePipelineContext;
}

export interface RunSystemTourOutput {
    readonly cacheHit:  boolean;
    readonly tour:      SystemTour;
    readonly inputHash: string;
}

/**
 * Stable hash over the case study — the sole input that influences the
 * tour. Mirrors `case-study-orchestrator.computeInputHash`: a sha256
 * digest, here over the canonical JSON serialisation of the case study so
 * identical evidence yields an identical cache key.
 */
export function computeCaseStudyHash(caseStudy: CaseStudy): string {
    return createHash('sha256').update(JSON.stringify(caseStudy)).digest('hex');
}

export async function runSystemTour(
    input: RunSystemTourInput,
): Promise<RunSystemTourOutput> {
    const inputHash = computeCaseStudyHash(input.caseStudy);

    // 1. Try the cache.
    let tour: SystemTour | undefined;
    let cacheHit = false;
    if (input.cache) {
        const hit = await input.cache.get(inputHash);
        if (hit) {
            tour = hit;
            cacheHit = true;
        }
    }

    // 2. Miss → invoke the agent, then populate the cache.
    if (!tour) {
        const result = await input.agent.invoke(input.caseStudy, input.ctx);
        tour = result.data;
        cacheHit = false;
        if (input.cache) {
            await input.cache.set(inputHash, tour);
        }
    }

    // 3. Persist.
    await input.repo.upsert(input.userId, input.projectId, tour, inputHash);

    return { cacheHit, tour, inputHash };
}
