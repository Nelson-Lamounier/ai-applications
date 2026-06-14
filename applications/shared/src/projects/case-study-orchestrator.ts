/**
 * @format
 * Compose the case-study loader, agent, grounding verifier, and
 * persistence into one entrypoint reusable by:
 *
 *   - the K8s Job (`applications/job-strategist/src/run-case-study.ts`)
 *   - the E2E test (`scripts/test-projects-case-study.ts`)
 *
 * Sequence:
 *
 *   1. Load CaseStudyContext (projects + components + repos + commits +
 *      KB chunks). Computes a stable hash of the model inputs.
 *   2. Optional semantic-cache lookup. If hit, persist the cached payload
 *      and return `cacheHit: true` — skips Sonnet entirely.
 *   3. Invoke the case-study agent (Sonnet 4.6 default) via injected
 *      `CaseStudyAgent`.
 *   4. Run BedrockGroundingVerifier (mode 'flag') across each decision /
 *      challenge / highlight, folding the verifier output into each
 *      row's `sourceSignals`. Mode 'flag' never rewrites content, so
 *      ungrounded text still ships but with explicit provenance.
 *   5. Hand off to the transactional persistence layer.
 *   6. Store the payload in the semantic cache for next time.
 */
import { createHash } from 'node:crypto';

import type { Pool } from 'pg';

import type { BasePipelineContext } from '../base-agent.js';
import type { ISemanticCache } from '../cache/cache-types.js';
import type { IGroundingVerifier } from '../grounding/grounding-types.js';

import type { CaseStudyAgent } from './case-study-agent.js';
import {
    loadCaseStudyContext,
    type LoadCaseStudyContextResult,
} from './case-study-loader.js';
import { reconstructPriorCaseStudy, underrepresentedRepos } from './case-study-refine.js';
import {
    persistCaseStudy,
    type PersistCaseStudySummary,
} from './case-study-persistence.js';
import {
    CaseStudySchema,
    type CaseStudy,
    type SourceSignal,
} from './case-study-types.js';
import {
    flattenSignalToContext,
    mergeGroundingResult,
} from './source-signals.js';

export interface RunCaseStudyInput {
    readonly projectId:     string;
    readonly pipelineRunId: string;
    readonly model:         string;
    readonly kbTag:         string;
    readonly agent:         CaseStudyAgent;
    readonly verifier?:     IGroundingVerifier;
    readonly cache?:        ISemanticCache;
    readonly ctx:               BasePipelineContext;
    /**
     * Incremental refine: when true and the project already has a completed
     * case study, the agent updates that prior study (preserving grounded rows)
     * rather than writing from scratch. Falls back to full generation when there
     * is no prior. The semantic cache is bypassed for refine runs — they
     * deliberately merge prior + new evidence and should always execute.
     */
    readonly refine?:       boolean;
}

export interface RunCaseStudyOutput {
    readonly cacheHit:   boolean;
    readonly refined:    boolean;
    readonly caseStudy:  CaseStudy;
    readonly persisted:  PersistCaseStudySummary;
    readonly inputHash:  string;
    readonly contextLoaded: LoadCaseStudyContextResult;
}

/**
 * Stable hash over the inputs that influence the model's output. If two
 * runs hash identically we can serve from the semantic cache instead of
 * re-invoking Sonnet.
 */
export function computeInputHash(context: LoadCaseStudyContextResult): string {
    const h = createHash('sha256');
    const c = context.context;
    h.update(c.projectId);
    h.update(c.projectName);
    h.update(c.tagline ?? '');
    h.update(c.pitch ?? '');
    for (const comp of c.components) h.update(`${comp.kind}:${comp.name}`);
    for (const repo of c.repositories) {
        h.update(repo.fullName);
        h.update(repo.techStack.join(','));
        h.update((repo.topics ?? []).join(','));
    }
    for (const commit of c.commits) {
        h.update(commit.sha);
    }
    for (const pr of c.pulls) {
        h.update(`pr:${pr.number}:${pr.state}:${pr.mergedAt ?? ''}`);
    }
    if (c.archetype) h.update(`arch:${c.archetype.id}`);
    if (c.stage)     h.update(`stage:${c.stage}`);
    if (c.prioritySections?.length)     h.update(`ps:${c.prioritySections.join(',')}`);
    if (c.deemphasizedSections?.length) h.update(`ds:${c.deemphasizedSections.join(',')}`);
    return h.digest('hex');
}

async function verifyDecision(
    verifier: IGroundingVerifier | undefined,
    answer: string,
    signal: SourceSignal,
): Promise<SourceSignal> {
    if (!verifier) return signal;
    const contextChunks = flattenSignalToContext(signal);
    if (contextChunks.length === 0) {
        // Nothing for the verifier to anchor against; record verdict explicitly.
        return { ...signal, grounding: 'NOT_VERIFIED' };
    }
    const result = await verifier.verify({
        query: 'Was every claim in this answer supported by the cited evidence?',
        contextChunks,
        answer,
    });
    return mergeGroundingResult(signal, result);
}

async function applyGrounding(
    caseStudy: CaseStudy,
    verifier?: IGroundingVerifier,
): Promise<CaseStudy> {
    if (!verifier) return caseStudy;
    return {
        ...caseStudy,
        decisions: await Promise.all(caseStudy.decisions.map(async (d) => ({
            ...d,
            sourceSignals: await verifyDecision(
                verifier,
                `${d.title}. ${d.context} ${d.decision} ${d.consequences}`,
                d.sourceSignals,
            ),
        }))),
        challenges: await Promise.all(caseStudy.challenges.map(async (c) => ({
            ...c,
            sourceSignals: await verifyDecision(verifier, `${c.problem} ${c.solution}`, c.sourceSignals),
        }))),
        highlights: await Promise.all(caseStudy.highlights.map(async (h) => ({
            ...h,
            sourceSignals: await verifyDecision(verifier, `${h.title}. ${h.description}`, h.sourceSignals),
        }))),
    };
}

const CACHE_SCOPE_PREFIX = 'casestudy';

export async function runCaseStudyOrchestration(
    pool: Pool,
    input: RunCaseStudyInput,
): Promise<RunCaseStudyOutput> {
    const baseContext = await loadCaseStudyContext(pool, input.projectId);
    const { contextLoaded, refined } = await resolveRefineContext(pool, baseContext, input);
    const inputHash = computeInputHash(contextLoaded);

    const cacheKey = {
        scope:     `${CACHE_SCOPE_PREFIX}:${contextLoaded.userId}:${input.projectId}`,
        kbTag:     input.kbTag,
        queryText: inputHash, // hash IS the query; small + deterministic
    };
    // The semantic cache is bypassed for refine runs — they merge prior + new
    // evidence and must always execute.
    const cacheable = Boolean(input.cache) && !refined;

    // 1. Try the cache.
    let caseStudy = cacheable ? await cacheGet(input.cache!, cacheKey) : undefined;
    const cacheHit = caseStudy !== undefined;

    // 2. Run the agent if the cache missed.
    if (!caseStudy) {
        const agentResult = await input.agent.invoke(contextLoaded.context, input.ctx);
        caseStudy = await applyGrounding(agentResult.data, input.verifier);
    }

    // 3. Persist.
    const client = await pool.connect();
    let persisted: PersistCaseStudySummary;
    try {
        persisted = await persistCaseStudy(client, {
            projectId:     input.projectId,
            userId:        contextLoaded.userId,
            pipelineRunId: input.pipelineRunId,
            model:         input.model,
            inputHash,
            caseStudy,
            computedArchetype: contextLoaded.context.archetype?.id ?? null,
            computedStage:     contextLoaded.context.stage ?? null,
        });
    } finally {
        client.release();
    }

    // 4. Update the cache (fail-open; never for cache hits or refine runs).
    if (cacheable && !cacheHit) await cachePut(input.cache!, cacheKey, caseStudy);

    return { cacheHit, refined, caseStudy, persisted, inputHash, contextLoaded };
}

interface CacheKey { scope: string; kbTag: string; queryText: string }

/**
 * Resolve the context to feed the agent: when `refine` is set and a completed
 * prior case study exists, attach it so the agent updates it. Otherwise the base
 * context drives a normal from-scratch generation.
 */
async function resolveRefineContext(
    pool: Pool,
    baseContext: LoadCaseStudyContextResult,
    input: RunCaseStudyInput,
): Promise<{ contextLoaded: LoadCaseStudyContextResult; refined: boolean }> {
    if (!input.refine) return { contextLoaded: baseContext, refined: false };
    const prior = await reconstructPriorCaseStudy(pool, input.projectId);
    if (!prior) return { contextLoaded: baseContext, refined: false };
    const repoNames = baseContext.context.repositories.map((r) => r.fullName);
    const refineNewRepos = underrepresentedRepos(prior, repoNames);
    return {
        contextLoaded: {
            ...baseContext,
            context: { ...baseContext.context, priorCaseStudy: prior, refineNewRepos },
        },
        refined: true,
    };
}

/** Cache read — returns the parsed CaseStudy on a valid hit, else undefined. Fail-open. */
async function cacheGet(cache: ISemanticCache, key: CacheKey): Promise<CaseStudy | undefined> {
    try {
        const hit = await cache.get(key);
        if (!hit.hit || !hit.response) return undefined;
        const parsed = CaseStudySchema.safeParse(hit.response);
        return parsed.success ? parsed.data : undefined;
    } catch {
        return undefined; // cache failures are non-fatal — fall through to a fresh run
    }
}

/** Cache write — fail-open; never throws. */
async function cachePut(cache: ISemanticCache, key: CacheKey, response: CaseStudy): Promise<void> {
    try {
        await cache.put({ ...key, response });
    } catch {
        // ignore
    }
}
