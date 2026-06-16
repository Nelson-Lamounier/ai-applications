/**
 * @format
 * TitanEmbeddingProvider — IEmbeddingProvider backed by Amazon Titan Embed Text v2
 *
 * Converts text to a 1024-dimensional float32 vector via Bedrock InvokeModel.
 * Single responsibility: embedding — no storage, no pipeline logic.
 *
 * Model: amazon.titan-embed-text-v2:0
 *   Input:  { inputText, dimensions, normalize }
 *   Output: { embedding: number[], inputTextTokenCount: number }
 *   Max input tokens: 8192
 *   Output dimensions: 256 | 512 | 1024 (configurable — defaults to 1024)
 */

import {
    BedrockRuntimeClient,
    InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';

import type { IEmbeddingProvider } from '../interfaces/IEmbeddingProvider.js';
import type { Pool } from 'pg';
import { recordBedrockCost } from '../bedrock-cost.js';

const MODEL_ID = 'amazon.titan-embed-text-v2:0';

// Titan Text Embeddings v2 enforces an 8,192-token limit. At ~4 chars/token
// for English, 30,000 chars ≈ 7,500 tokens. But this char heuristic is only
// an *upper-bound guess*: dense content (minified code, non-English, long
// identifiers) packs far more tokens per char, so a chunk under MAX_INPUT_CHARS
// can still blow past 8,192 tokens and earn a 400 ValidationException. The
// initial char cap keeps the common case cheap; embed() additionally
// shrink-retries on a token-limit overflow so dense chunks still succeed.
const MAX_INPUT_CHARS = 30_000;

/** Titan's hard input-token ceiling. */
const MAX_INPUT_TOKENS = 8_192;

/** Bounded retry budget for token-overflow shrink-and-retry. */
const MAX_OVERFLOW_RETRIES = 4;

/**
 * Detect Bedrock's "too many input tokens" ValidationException and extract the
 * reported request token count, e.g.
 *   "... Max input tokens: 8192, request input token count: 10937"
 * Returns the request token count when this is a token-limit error, else null.
 */
function parseTokenOverflow(err: unknown): number | null {
    const e = err as { name?: string; message?: string } | undefined;
    const msg = e?.message ?? '';
    if (!/too many input tokens/i.test(msg) && !/input token count/i.test(msg)) return null;
    const m = msg.match(/request input token count:\s*(\d+)/i);
    return m ? Number.parseInt(m[1], 10) : MAX_INPUT_TOKENS + 1;
}

export interface TitanCostContext {
    pool:     Pool;
    userId:   string;
    repoName: string;
    // 'initial' | 'full_reindex' | 'incremental' — distinguishes an initial
    // repo ingest from a resync on the per-repo Cost breakdown (migration 082).
    syncKind?: string;
}

export class TitanEmbeddingProvider implements IEmbeddingProvider {
    readonly dimension: number;

    private readonly client: BedrockRuntimeClient;
    private readonly region: string;
    private readonly costCtx?: TitanCostContext;

    constructor(region: string, dimension: 256 | 512 | 1024 = 1024, costCtx?: TitanCostContext) {
        this.region    = region;
        this.dimension = dimension;
        this.client    = new BedrockRuntimeClient({ region });
        this.costCtx   = costCtx;
    }

    /**
     * Resolve from Lambda environment variables.
     * AWS_REGION is set automatically by the Lambda runtime.
     * EMBEDDING_DIMENSION is optional — defaults to 1024 (Titan v2 maximum).
     */
    static fromEnvironment(): TitanEmbeddingProvider {
        const region    = process.env.AWS_REGION ?? 'us-east-1';
        const dimRaw    = process.env.EMBEDDING_DIMENSION;
        const dimension = dimRaw ? (parseInt(dimRaw, 10) as 256 | 512 | 1024) : 1024;

        return new TitanEmbeddingProvider(region, dimension);
    }

    // =========================================================================
    // IEmbeddingProvider.embed
    // =========================================================================

    async embed(text: string): Promise<number[]> {
        // Initial char cap covers the common case cheaply.
        let input = text.length > MAX_INPUT_CHARS ? text.slice(0, MAX_INPUT_CHARS) : text;

        for (let attempt = 0; ; attempt++) {
            try {
                return await this.invokeOnce(input);
            } catch (err) {
                const requestTokens = parseTokenOverflow(err);
                // Non-token-limit error, or out of retries → propagate.
                if (requestTokens === null || attempt >= MAX_OVERFLOW_RETRIES) throw err;

                // Shrink by the observed char-per-token ratio so the next
                // attempt projects under the 8,192-token ceiling, with a 5%
                // safety margin. Using the real ratio (chars sent / tokens
                // reported) handles any content density, unlike a fixed
                // chars/token guess. Guard against non-progress.
                const charsPerToken = input.length / requestTokens;
                const target = Math.floor(MAX_INPUT_TOKENS * charsPerToken * 0.95);
                const nextLen = Math.min(target, input.length - 1);
                if (nextLen <= 0) throw err;
                input = input.slice(0, nextLen);
            }
        }
    }

    /** Single InvokeModel round-trip + cost recording. Throws SDK errors as-is. */
    private async invokeOnce(inputText: string): Promise<number[]> {
        const body = JSON.stringify({ inputText, dimensions: this.dimension, normalize: true });

        const { body: responseBody } = await this.client.send(
            new InvokeModelCommand({
                modelId:     MODEL_ID,
                contentType: 'application/json',
                accept:      'application/json',
                body:        Buffer.from(body),
            }),
        );

        const parsed = JSON.parse(Buffer.from(responseBody).toString('utf-8')) as {
            embedding:           number[];
            inputTextTokenCount: number;
        };

        if (this.costCtx) {
            recordBedrockCost(this.costCtx.pool, {
                userId:       this.costCtx.userId,
                modelId:      MODEL_ID,
                pipeline:     'repo-sync',
                agent:        'titan-embed',
                inputTokens:  parsed.inputTextTokenCount ?? 0,
                outputTokens: 0,
                repoName:     this.costCtx.repoName,
                syncKind:     this.costCtx.syncKind,
            }).catch((err) => console.warn('[TitanEmbeddingProvider] cost record failed (non-fatal)', err));
        }

        return parsed.embedding;
    }
}
