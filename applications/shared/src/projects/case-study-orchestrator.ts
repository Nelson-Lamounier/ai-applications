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
import type { WorkflowTrace } from '../observability/workflow-trace.js';

import { CASE_STUDY_PROMPT_VERSION, type CaseStudyAgent } from './case-study-agent.js';
import {
    loadCaseStudyContext,
    type LoadCaseStudyContextResult,
} from './case-study-loader.js';
import { reconstructPriorCaseStudy, underrepresentedRepos, scopeEvidenceToRepos } from './case-study-refine.js';
import { deriveArticleCandidates } from './article-topic-discovery.js';
import {
    persistCaseStudy,
    type PersistCaseStudySummary,
} from './case-study-persistence.js';
import {
    CaseStudySchema,
    type CaseStudy,
    type SourceSignal,
} from './case-study-types.js';

export type RunCaseStudyStage =
    | 'fetching_context'
    | 'generating'
    | 'grounding'
    | 'persisting';

export interface RunCaseStudyInput {
    readonly projectId:     string;
    readonly pipelineRunId: string;
    readonly model:         string;
    readonly kbTag:         string;
    readonly agent:         CaseStudyAgent;
    readonly cache?:        ISemanticCache;
    readonly ctx:           BasePipelineContext;
    readonly workflow?:     WorkflowTrace;
    readonly onStage?:      (stage: RunCaseStudyStage) => Promise<void>;
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
    readonly grounding:  GroundingSummary;
    readonly persisted:  PersistCaseStudySummary;
    readonly inputHash:  string;
    readonly contextLoaded: LoadCaseStudyContextResult;
    /** Article topic candidates written as a byproduct (0 when the feature is off or discovery no-ops). */
    readonly topicCandidatesWritten: number;
}

export interface GroundingSummary {
    readonly checked: number;
    readonly grounded: number;
    readonly flagged: number;
    readonly notVerified: number;
}

function updateOptionalHash(hash: ReturnType<typeof createHash>, prefix: string, value: string | null | undefined): void {
    if (!value) return;
    hash.update(`${prefix}${value}`);
}

function updateListHash(hash: ReturnType<typeof createHash>, values: readonly string[], prefix: string): void {
    if (values.length === 0) return;
    hash.update(`${prefix}${values.join(',')}`);
}

function updateComponentHash(hash: ReturnType<typeof createHash>, context: LoadCaseStudyContextResult['context']): void {
    for (const component of context.components) hash.update(`${component.kind}:${component.name}`);
}

function updateRepositoryHash(hash: ReturnType<typeof createHash>, context: LoadCaseStudyContextResult['context']): void {
    for (const repo of context.repositories) {
        hash.update(repo.fullName);
        hash.update(repo.techStack.join(','));
        hash.update((repo.topics ?? []).join(','));
    }
}

function updateCommitHash(hash: ReturnType<typeof createHash>, context: LoadCaseStudyContextResult['context']): void {
    for (const commit of context.commits) hash.update(commit.sha);
}

function updatePullHash(hash: ReturnType<typeof createHash>, context: LoadCaseStudyContextResult['context']): void {
    for (const pull of context.pulls) {
        hash.update(`pr:${pull.number}:${pull.state}:${pull.mergedAt ?? ''}`);
    }
}

/**
 * Stable hash over the inputs that influence the model's output. If two
 * runs hash identically we can serve from the semantic cache instead of
 * re-invoking Sonnet. The prompt version is part of the key so a prompt
 * change busts the cache — an otherwise-unchanged project then re-runs
 * Sonnet on the new prompt instead of serving a stale cached case study.
 */
export function computeInputHash(
    context: LoadCaseStudyContextResult,
    promptVersion: string = CASE_STUDY_PROMPT_VERSION,
): string {
    const h = createHash('sha256');
    const c = context.context;
    h.update(`prompt:${promptVersion}`);
    h.update(c.projectId);
    h.update(c.projectName);
    h.update(c.tagline ?? '');
    h.update(c.pitch ?? '');
    h.update(c.productContext ?? '');
    updateComponentHash(h, c);
    updateRepositoryHash(h, c);
    updateCommitHash(h, c);
    updatePullHash(h, c);
    updateOptionalHash(h, 'arch:', c.archetype?.id);
    updateOptionalHash(h, 'stage:', c.stage);
    updateListHash(h, c.prioritySections ?? [], 'ps:');
    updateListHash(h, c.deemphasizedSections ?? [], 'ds:');
    return h.digest('hex');
}

/**
 * Deterministic grounding: a row is GROUNDED when it cites at least one piece of
 * evidence (commit / PR / file), else NOT_VERIFIED.
 *
 * The case-study agent is constrained by its schema + system prompt to narrate
 * ONLY from the supplied evidence and to drop any row it cannot cite, so
 * citation-presence IS the grounding signal. The previous per-row LLM verifier
 * re-judged rich prose against thin citation labels (commit subject, PR title,
 * bare file path) and flagged ~100% as NOT_GROUNDED — noise that misrepresented
 * genuinely-evidenced rows and burned ~15 Haiku calls per run. The
 * hallucination safety net is being redesigned separately; until then, grounding
 * reflects whether the model cited evidence, which is what the schema enforces.
 */
function groundFromCitations(signal: SourceSignal): SourceSignal {
    const hasEvidence =
        signal.commits.length > 0 || signal.pulls.length > 0 || signal.files.length > 0;
    return { ...signal, grounding: hasEvidence ? 'GROUNDED' : 'NOT_VERIFIED' };
}

function applyGrounding(caseStudy: CaseStudy): CaseStudy {
    return {
        ...caseStudy,
        decisions:  caseStudy.decisions.map((d)  => ({ ...d, sourceSignals: groundFromCitations(d.sourceSignals) })),
        challenges: caseStudy.challenges.map((c) => ({ ...c, sourceSignals: groundFromCitations(c.sourceSignals) })),
        highlights: caseStudy.highlights.map((h) => ({ ...h, sourceSignals: groundFromCitations(h.sourceSignals) })),
    };
}

export function summarizeGrounding(caseStudy: CaseStudy): GroundingSummary {
    const signals = [
        ...caseStudy.decisions.map((row) => row.sourceSignals),
        ...caseStudy.highlights.map((row) => row.sourceSignals),
        ...caseStudy.challenges.map((row) => row.sourceSignals),
    ];
    return {
        checked: signals.filter((s) => s.grounding !== 'NOT_VERIFIED').length,
        grounded: signals.filter((s) => s.grounding === 'GROUNDED').length,
        flagged: signals.filter((s) => s.grounding === 'NOT_GROUNDED').length,
        notVerified: signals.filter((s) => s.grounding === 'NOT_VERIFIED').length,
    };
}

const CACHE_SCOPE_PREFIX = 'casestudy';

async function runStage<T>(
    workflow: WorkflowTrace | undefined,
    name: string,
    work: () => Promise<T>,
): Promise<T> {
    return workflow ? workflow.stage(name, {}, work) : work();
}

export async function runCaseStudyOrchestration(
    pool: Pool,
    input: RunCaseStudyInput,
): Promise<RunCaseStudyOutput> {
    await input.onStage?.('fetching_context');
    const { contextLoaded, refined } = await runStage(input.workflow, 'project.case_study.load_context', async () => {
        const baseContext = await loadCaseStudyContext(pool, input.projectId);
        return resolveRefineContext(pool, baseContext, input);
    });
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
    let caseStudy = await runStage(input.workflow, 'project.case_study.cache_lookup', async () =>
        cacheable ? cacheGet(input.cache!, cacheKey) : undefined,
    );
    const cacheHit = caseStudy !== undefined;

    // 2. Run the agent if the cache missed.
    if (!caseStudy) {
        await input.onStage?.('generating');
        const agentResult = await runStage(input.workflow, 'project.case_study.generate', async () =>
            input.agent.invoke(contextLoaded.context, input.ctx),
        );
        await input.onStage?.('grounding');
        caseStudy = await runStage(input.workflow, 'project.case_study.ground', async () =>
            applyGrounding(agentResult.data),
        );
    }

    // 2b. Override depthMarkers with the deterministic, code-grounded values
    // (test/CI/deploy/docs maturity from fileClass lanes + archetype) — depth is
    // measured, not the model's guess. Applied to cached results too (idempotent).
    const groundedDepth = contextLoaded.context.depthMarkers;
    if (groundedDepth) caseStudy = { ...caseStudy, depthMarkers: groundedDepth };

    // 3. Persist.
    await input.onStage?.('persisting');
    const persisted = await runStage(input.workflow, 'project.case_study.persist', async () => {
        const client = await pool.connect();
        try {
            return await persistCaseStudy(client, {
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
    });

    // 4. Update the cache (fail-open; never for cache hits or refine runs).
    if (cacheable && !cacheHit) {
        await runStage(input.workflow, 'project.case_study.cache_write', async () =>
            cachePut(input.cache!, cacheKey, caseStudy),
        );
    }

    // 5. Article topic discovery (best-effort byproduct). Reuses the case study
    // just produced — no re-scan/re-embed — to write narrow, problem-framed
    // article candidates keyed by github_repo_id. Fail-open and feature-flagged:
    // it must NEVER fail or slow the case-study run. Off unless ARTICLE_TOPIC_DISCOVERY=1.
    let topicCandidatesWritten = 0;
    if (process.env['ARTICLE_TOPIC_DISCOVERY'] === '1') {
        topicCandidatesWritten = await runStage(input.workflow, 'project.case_study.topic_discovery', async () => {
            try {
                return await deriveArticleCandidates(pool, {
                    userId:        contextLoaded.userId,
                    projectId:     input.projectId,
                    pipelineRunId: input.pipelineRunId,
                    caseStudy,
                    repoFullNames: contextLoaded.context.repositories.map((r) => r.fullName),
                });
            } catch {
                return 0; // best-effort; a discovery failure never breaks case-study generation
            }
        });
    }

    return {
        cacheHit,
        refined,
        caseStudy,
        grounding: summarizeGrounding(caseStudy),
        persisted,
        inputHash,
        contextLoaded,
        topicCandidatesWritten,
    };
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
    // Cost-scope: when there ARE newly-added repos, drop old repos' commits/PRs/KB
    // from the prompt — the prior case study covers them. A plain re-refine (no new
    // repo) keeps full context so the agent can still re-ground from scratch.
    const scoped = refineNewRepos.length > 0
        ? scopeEvidenceToRepos(baseContext.context, refineNewRepos)
        : baseContext.context;
    return {
        contextLoaded: {
            ...baseContext,
            context: { ...scoped, priorCaseStudy: prior, refineNewRepos },
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
