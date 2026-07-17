/**
 * @format
 * Project Clustering Agent — Bedrock tool-use, Haiku 4.5.
 *
 * Receives compact per-repo digests + deterministic signals; emits multi-
 * repo groupings with confidence + reasoning. Single-repo proposals are
 * NOT emitted — backfill migration 031 already created a default project
 * per repo, so the agent's job is only to propose merges.
 *
 * Pipeline position (clustering K8s Job):
 *   queued → signals_extracting → analysing → persisting → complete
 *
 * The clustering agent is structured so it can be injected (mocked) in
 * tests — `runClusteringAgent` is a thin function over `runAgent<T>()`,
 * not a class, so tests pass in an alternative implementation via the
 * `agent` dependency in `runClustering()`.
 */

import type { SystemContentBlock } from '@aws-sdk/client-bedrock-runtime';

import { runAgent, parseJsonResponse } from '../../agent-runner.js';
import type { BasePipelineContext } from '../../base-agent.js';
import type {
    AgentConfig,
    AgentResult,
} from '../../types.js';

import {
    ClusteringResultSchema,
    type ClusteringResult,
    type ClusteringSignals,
    type RepoClusteringDigest,
} from '../types.js';
import { serialiseSignalsForPrompt } from './clustering-signals.js';

// ─── Configuration ──────────────────────────────────────────────────────────

/** Haiku 4.5 — fast, structured-output-friendly, cheap. */
const CLUSTERING_MODEL =
    process.env.CLUSTERING_MODEL ??
    'eu.anthropic.claude-haiku-4-5-20251001-v1:0';

/** Application Inference Profile ARN — preferred for FinOps attribution. */
const EFFECTIVE_MODEL_ID =
    process.env.INFERENCE_PROFILE_ARN ?? CLUSTERING_MODEL;

const CLUSTERING_MAX_TOKENS = 4096;

/** Forced tool_use is incompatible with extended thinking. See structure-output-checklist §2. */
const CLUSTERING_THINKING_BUDGET = 0;

const MAX_PROPOSALS = 8;

// ─── System prompt ──────────────────────────────────────────────────────────

const SYSTEM_PROMPT_TEXT = `You are a portfolio analyst. Your job is to look at a user's GitHub
repositories and propose which of them belong together as a single
"project" the user would describe in a job interview.

Rules:
  1. Only emit groupings of TWO OR MORE repositories. Solo repos are
     already represented as default single-repo projects — never propose
     a group of size one.
  2. Cap your output at ${MAX_PROPOSALS} groupings. If you would exceed it,
     drop the lowest-confidence groupings.
  3. Every grouping must have at least one component. A component carries
     a role (frontend / backend / infra / mobile / data / ml / docs /
     shared) and the repositories that play that role.
  4. Reference repositories ONLY by the UUIDs given in the input. Never
     invent ids, never refer to repos by name in \`repositoryIds\`.
  5. \`reasoning\` is a short, recruiter-friendly paragraph (≤ 400 chars)
     explaining WHY these repos belong together — name the strongest
     signal (shared prefix, shared tech, infra coupling).
  6. \`confidence\` is "high" when at least TWO independent signals
     agree (e.g. shared prefix AND shared tech stack), "medium" with one
     strong signal, "low" otherwise. Be honest — low-confidence proposals
     are dropped by the orchestrator if the cap is exceeded.

You are given two inputs:
  - a JSON array of repo digests (id, fullName, shortName, language,
    topics, lastSeenAt, techStack, classification)
  - a JSON signals block containing precomputed correlations (naming
    prefixes, shared topics, shared tech stack, embedding pairs).

The signals are evidence; use them, do not recompute them.`;

const SYSTEM_PROMPT: SystemContentBlock[] = [{ text: SYSTEM_PROMPT_TEXT }];

// ─── Forced tool_use schema ─────────────────────────────────────────────────

const PROJECT_COMPONENT_KIND_VALUES = [
    'frontend', 'backend', 'infra', 'mobile',
    'data', 'ml', 'docs', 'shared',
] as const;

const CLUSTERING_TOOL = {
    name: 'emit_project_groupings',
    description:
        'Emit multi-repo project proposals. Solo repos are excluded — never group size 1.',
    inputSchema: {
        type: 'object',
        properties: {
            proposals: {
                type: 'array',
                maxItems: MAX_PROPOSALS,
                items: {
                    type: 'object',
                    properties: {
                        name:       { type: 'string', minLength: 1, maxLength: 120 },
                        confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
                        reasoning:  { type: 'string', minLength: 1, maxLength: 2000 },
                        components: {
                            type: 'array',
                            minItems: 1,
                            items: {
                                type: 'object',
                                properties: {
                                    name:          { type: 'string', minLength: 1, maxLength: 80 },
                                    kind:          { type: 'string', enum: [...PROJECT_COMPONENT_KIND_VALUES] },
                                    repositoryIds: {
                                        type: 'array',
                                        minItems: 1,
                                        items: { type: 'string', format: 'uuid' },
                                    },
                                },
                                required: ['name', 'kind', 'repositoryIds'],
                                additionalProperties: false,
                            },
                        },
                    },
                    required: ['name', 'confidence', 'reasoning', 'components'],
                    additionalProperties: false,
                },
            },
        },
        required: ['proposals'],
        additionalProperties: false,
    },
};

// ─── User message ───────────────────────────────────────────────────────────

function buildUserMessage(
    digests: readonly RepoClusteringDigest[],
    signals: ClusteringSignals,
): string {
    const digestJson = JSON.stringify(
        digests.map((d) => ({
            repositoryId:    d.repositoryId,
            fullName:        d.fullName,
            shortName:       d.shortName,
            primaryLanguage: d.primaryLanguage,
            topics:          d.topics,
            techStack:       d.techStack,
            classification:  d.classification,
            firstSeenAt:     d.firstSeenAt,
            lastSyncedAt:    d.lastSyncedAt,
        })),
    );
    return [
        '<repos>',
        digestJson,
        '</repos>',
        '<signals>',
        serialiseSignalsForPrompt(signals),
        '</signals>',
        '',
        'Emit the proposals tool now.',
    ].join('\n');
}

// ─── Validation ─────────────────────────────────────────────────────────────

/**
 * Strip any proposals that reference unknown repository ids. The model is
 * grounded in the input digest, but a defensive filter here prevents an
 * upstream regression from silently corrupting persistence.
 */
function filterToKnownRepos(
    result: ClusteringResult,
    knownIds: ReadonlySet<string>,
): ClusteringResult {
    const filteredProposals = result.proposals
        .map((p) => ({
            ...p,
            components: p.components
                .map((c) => ({
                    ...c,
                    repositoryIds: c.repositoryIds.filter((id) => knownIds.has(id)),
                }))
                .filter((c) => c.repositoryIds.length > 0),
        }))
        .filter((p) => {
            if (p.components.length === 0) return false;
            // Drop single-repo groupings the model emitted by accident.
            const total = p.components.reduce((n, c) => n + c.repositoryIds.length, 0);
            return total >= 2;
        });
    return { proposals: filteredProposals };
}

// ─── Entrypoint ─────────────────────────────────────────────────────────────

/**
 * The agent interface — exposed separately so tests can inject a mock
 * implementation without spinning up Bedrock.
 */
export interface ClusteringAgent {
    invoke(
        digests: readonly RepoClusteringDigest[],
        signals: ClusteringSignals,
        ctx: BasePipelineContext,
    ): Promise<AgentResult<ClusteringResult>>;
}

/** Bedrock-backed implementation. */
export const bedrockClusteringAgent: ClusteringAgent = {
    async invoke(digests, signals, ctx) {
        const knownIds = new Set(digests.map((d) => d.repositoryId));

        const config: AgentConfig = {
            agentName:      'project-clustering',
            modelId:        EFFECTIVE_MODEL_ID,
            maxTokens:      CLUSTERING_MAX_TOKENS,
            thinkingBudget: CLUSTERING_THINKING_BUDGET,
            systemPrompt:   SYSTEM_PROMPT,
            pipeline:       'project-clustering',
            promptId:       'project-clustering-v1',
            tool:           CLUSTERING_TOOL,
        };

        const result = await runAgent<ClusteringResult>({
            config,
            userMessage:    buildUserMessage(digests, signals),
            pipelineContext: ctx,
            parseResponse: (text) => {
                // runAgent supplies the toolUse.input as a JSON string when
                // `tool` is configured; parse it and validate with Zod.
                const raw = parseJsonResponse<unknown>(text, 'project-clustering');
                const parsed = ClusteringResultSchema.safeParse(raw);
                if (!parsed.success) {
                    throw new Error(
                        `clustering output failed schema: ${parsed.error.message}`,
                    );
                }
                return filterToKnownRepos(parsed.data, knownIds);
            },
        });
        return result;
    },
};
