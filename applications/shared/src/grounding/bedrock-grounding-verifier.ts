/**
 * @format
 * BedrockGroundingVerifier — checklist section 6 grounding check via Converse.
 *
 * Runs the source-vs-answer prompt on a cheap model (Haiku 4.5). Fail-safe:
 * any parse ambiguity resolves to NOT_GROUNDED so hallucinations are never
 * silently treated as grounded.
 */

import {
    BedrockRuntimeClient,
    ConverseCommand,
    type ConverseCommandOutput,
} from '@aws-sdk/client-bedrock-runtime';
import type { Pool } from 'pg';

import { emitEmfMetric } from '../emf.js';
import { recordBedrockCost } from '../rds/bedrock-cost.js';
import {
    DEFAULT_GROUNDING_FALLBACK,
    type GroundingInput,
    type GroundingMode,
    type GroundingResult,
    type IGroundingVerifier,
} from './grounding-types.js';

const METRIC_NAMESPACE = 'BedrockSharedSafety';

/** Per-call context for booking the verifier's Haiku spend into
 *  prompt_invocations. Optional — when omitted (or userId absent) the call is
 *  still made but not recorded. */
export interface GroundingCostContext {
    pool:   Pool;
    userId: string;
}

export interface BedrockGroundingVerifierConfig {
    readonly mode: GroundingMode;
    readonly modelId?: string;
    readonly fallback?: string;
    readonly client?: BedrockRuntimeClient;
}

function buildPrompt(i: GroundingInput): string {
    return [
        'Given the following source chunks:',
        i.contextChunks.map((c, n) => `[${n + 1}] ${c}`).join('\n'),
        '',
        'And the following generated answer:',
        i.answer,
        '',
        'Is every claim in the answer directly supported by the source chunks?',
        'Reply on the first line with exactly GROUNDED or NOT_GROUNDED.',
        'Then "Reason: <brief reason>".',
        'If NOT_GROUNDED, add "Claims: <semicolon-separated unsupported claims>".',
    ].join('\n');
}

function parse(text: string): { status: 'GROUNDED' | 'NOT_GROUNDED'; reason: string; claims: string[] } {
    const grounded = /\bGROUNDED\b/.test(text) && !/\bNOT_GROUNDED\b/.test(text);
    const reason = /Reason:\s*(.+)/i.exec(text)?.[1]?.trim() ?? '';
    const claimsRaw = /Claims:\s*(.+)/i.exec(text)?.[1]?.trim() ?? '';
    const claims = claimsRaw ? claimsRaw.split(';').map(c => c.trim()).filter(Boolean) : [];
    const hasVerdict = /\bGROUNDED\b/.test(text) || /\bNOT_GROUNDED\b/.test(text);
    if (!hasVerdict) {
        console.warn(
            '[grounding-verifier] unparseable model output — defaulting to NOT_GROUNDED:',
            text.substring(0, 200),
        );
    }
    return { status: grounded ? 'GROUNDED' : 'NOT_GROUNDED', reason, claims };
}

export class BedrockGroundingVerifier implements IGroundingVerifier {
    private readonly mode: GroundingMode;
    private readonly modelId: string;
    private readonly fallback: string;
    private readonly client: BedrockRuntimeClient;

    constructor(config: BedrockGroundingVerifierConfig) {
        this.mode = config.mode;
        this.modelId = config.modelId ?? process.env.GROUNDING_MODEL_ID ?? 'eu.anthropic.claude-haiku-4-5-20251001-v1:0';
        this.fallback = config.fallback ?? DEFAULT_GROUNDING_FALLBACK;
        this.client = config.client ?? new BedrockRuntimeClient({});
    }

    async verify(input: GroundingInput, costCtx?: GroundingCostContext): Promise<GroundingResult> {
        const command = new ConverseCommand({
            modelId: this.modelId,
            messages: [{ role: 'user', content: [{ text: buildPrompt(input) }] }],
            inferenceConfig: { maxTokens: 512 },
        });
        const response: ConverseCommandOutput = await this.client.send(command);

        if (costCtx?.userId) {
            // Awaited (not fire-and-forget): the INSERT must finish before the caller
            // returns, else a short-lived pool (run-coach) can close before the dangling
            // query runs ("Cannot use a pool after calling end on the pool"). Stays
            // fail-open via .catch.
            await recordBedrockCost(costCtx.pool, {
                userId:       costCtx.userId,
                modelId:      this.modelId,
                pipeline:     'grounding-verify',
                inputTokens:  response.usage?.inputTokens  ?? 0,
                outputTokens: response.usage?.outputTokens ?? 0,
            }).catch((err) => console.warn('[grounding-verifier] cost record failed (non-fatal)', err));
        }

        const text =
            response.output?.message?.content?.find(
                (b): b is { text: string } => typeof (b as { text?: unknown }).text === 'string',
            )?.text ?? '';
        const { status, reason, claims } = parse(text);

        emitEmfMetric(
            METRIC_NAMESPACE,
            { Module: 'grounding', Mode: this.mode },
            [
                { name: 'GroundingChecked', value: 1, unit: 'Count' },
                { name: 'GroundingFailed', value: status === 'NOT_GROUNDED' ? 1 : 0, unit: 'Count' },
            ],
        );

        const answer =
            this.mode === 'block' && status === 'NOT_GROUNDED' ? this.fallback : input.answer;
        return { status, reason, ungroundedClaims: claims, answer };
    }
}
