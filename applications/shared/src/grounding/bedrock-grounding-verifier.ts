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
} from '@aws-sdk/client-bedrock-runtime';

import { emitEmfMetric } from '../emf.js';
import {
    DEFAULT_GROUNDING_FALLBACK,
    type GroundingInput,
    type GroundingMode,
    type GroundingResult,
    type IGroundingVerifier,
} from './grounding-types.js';

const DEFAULT_MODEL_ID =
    process.env.GROUNDING_MODEL_ID ?? 'eu.anthropic.claude-haiku-4-5-20251001-v1:0';
const METRIC_NAMESPACE = 'BedrockSharedSafety';

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
    return { status: grounded ? 'GROUNDED' : 'NOT_GROUNDED', reason, claims };
}

export class BedrockGroundingVerifier implements IGroundingVerifier {
    private readonly mode: GroundingMode;
    private readonly modelId: string;
    private readonly fallback: string;
    private readonly client: BedrockRuntimeClient;

    constructor(config: BedrockGroundingVerifierConfig) {
        this.mode = config.mode;
        this.modelId = config.modelId ?? DEFAULT_MODEL_ID;
        this.fallback = config.fallback ?? DEFAULT_GROUNDING_FALLBACK;
        this.client = config.client ?? new BedrockRuntimeClient({});
    }

    async verify(input: GroundingInput): Promise<GroundingResult> {
        const command = new ConverseCommand({
            modelId: this.modelId,
            messages: [{ role: 'user', content: [{ text: buildPrompt(input) }] }],
            inferenceConfig: { maxTokens: 512 },
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const response = await (this.client.send(command) as Promise<any>);
        const text =
            response?.output?.message?.content?.find((b: { text?: string }) => typeof b.text === 'string')?.text ?? '';
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
