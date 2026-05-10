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

const MODEL_ID = 'amazon.titan-embed-text-v2:0';

// Bedrock rejects payloads whose inputText exceeds this character count.
// Truncation preserves the leading content (most semantically dense) rather
// than failing the entire chunk and crashing the ingestion job.
const MAX_INPUT_CHARS = 50_000;

export class TitanEmbeddingProvider implements IEmbeddingProvider {
    readonly dimension: number;

    private readonly client: BedrockRuntimeClient;
    private readonly region: string;

    constructor(region: string, dimension: 256 | 512 | 1024 = 1024) {
        this.region = region;
        this.dimension = dimension;
        this.client = new BedrockRuntimeClient({ region });
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
        const body = JSON.stringify({
            inputText:  text.length > MAX_INPUT_CHARS ? text.slice(0, MAX_INPUT_CHARS) : text,
            dimensions: this.dimension,
            normalize:  true,
        });

        const { body: responseBody } = await this.client.send(
            new InvokeModelCommand({
                modelId:     MODEL_ID,
                contentType: 'application/json',
                accept:      'application/json',
                body:        Buffer.from(body),
            }),
        );

        const parsed = JSON.parse(Buffer.from(responseBody).toString('utf-8')) as {
            embedding: number[];
            inputTextTokenCount: number;
        };

        return parsed.embedding;
    }
}
