/**
 * @format
 * BedrockReranker — IReranker backed by AWS Bedrock Rerank API
 *
 * Single API call per rerank. Cross-encoder model reads (query, candidate)
 * pairs and returns relevance scores. Replaces the cosine-only ordering
 * from vector retrieval with a more accurate downstream ranking.
 *
 * Default model:
 *   amazon.rerank-v1:0 — broadly available in AWS regions including
 *   eu-west-1. Override via RERANKER_MODEL_ARN to pin a different model
 *   (e.g. cohere.rerank-v3-5:0 in supported regions).
 *
 * Constraints:
 *   - Bedrock Rerank caps each call at 100 candidates and ~5000 chars
 *     per candidate. We truncate per-candidate text to be safe; the
 *     caller is responsible for keeping batches at or below the cap.
 *
 * Cost: ~$0.001 per rerank call at the AWS reference pricing for
 * rerank-v1:0. Per-resume cost is dominated by generation, not rerank.
 */

import {
    BedrockAgentRuntimeClient,
    RerankCommand,
} from '@aws-sdk/client-bedrock-agent-runtime';

import type {
    IReranker,
    RerankCandidate,
    RerankOptions,
    RerankResult,
} from '../interfaces/IReranker.js';

// Bedrock rerank models aren't offered in eu-west-1 (the cluster region), so the
// reranker invokes a US region cross-region. Default = the FIRST-PARTY
// amazon.rerank-v1:0 in us-west-2 — verified in this account as ACTIVE + AUTHORIZED with
// the Marketplace agreement AVAILABLE (no subscription needed) and live-tested via the
// Rerank API. The prior default (cohere.rerank-v3-5:0, us-east-1) returns a 403 because
// its Marketplace agreement is NOT_AVAILABLE here (it requires an AWS Marketplace
// subscription). The job role's bedrock grant is region-wildcarded, so cross-region
// invoke is permitted. Override via RERANKER_MODEL_ID / RERANKER_REGION.
const DEFAULT_MODEL_ID = 'amazon.rerank-v1:0';
const DEFAULT_REGION   = 'us-west-2';

/** Conservative per-candidate length cap. The API max is higher but cutting
 *  earlier saves bandwidth without hurting rerank quality. */
const MAX_TEXT_CHARS = 4_000;

/** Bedrock Rerank's hard cap on candidates per call. */
const MAX_CANDIDATES_PER_CALL = 100;

export interface BedrockRerankerConfig {
    /** Override the rerank model id. Default: amazon.rerank-v1:0. */
    readonly modelId?: string;
    /** Region to invoke Bedrock in. Defaults to AWS_REGION env. */
    readonly region?:  string;
}

export class BedrockReranker implements IReranker {
    private readonly client:   BedrockAgentRuntimeClient;
    private readonly modelArn: string;

    constructor(config: BedrockRerankerConfig = {}) {
        // RERANKER_REGION (NOT AWS_REGION) — the rerank model lives in a specific
        // region independent of where the pod runs. Falls back to us-east-1.
        const region   = config.region ?? process.env.RERANKER_REGION ?? DEFAULT_REGION;
        const modelId  = config.modelId ?? process.env.RERANKER_MODEL_ID ?? DEFAULT_MODEL_ID;
        this.client    = new BedrockAgentRuntimeClient({ region });
        this.modelArn  = modelId.startsWith('arn:')
            ? modelId
            : `arn:aws:bedrock:${region}::foundation-model/${modelId}`;
    }

    static fromEnvironment(): BedrockReranker {
        return new BedrockReranker({
            modelId: process.env.RERANKER_MODEL_ID,
            region:  process.env.RERANKER_REGION,
        });
    }

    // =========================================================================
    // IReranker
    // =========================================================================

    async rerank(
        query:      string,
        candidates: readonly RerankCandidate[],
        opts:       RerankOptions = {},
    ): Promise<RerankResult[]> {
        if (candidates.length === 0) return [];
        if (candidates.length > MAX_CANDIDATES_PER_CALL) {
            // Caller error — surface loudly rather than silently truncating.
            throw new Error(
                `BedrockReranker: candidate count ${candidates.length} exceeds ` +
                `the per-call cap of ${MAX_CANDIDATES_PER_CALL}. ` +
                `Slice the input or rerank in batches.`,
            );
        }

        const topK = Math.min(opts.topK ?? candidates.length, candidates.length);

        const sources = candidates.map(c => ({
            type: 'INLINE' as const,
            inlineDocumentSource: {
                type: 'TEXT' as const,
                textDocument: {
                    text: c.text.slice(0, MAX_TEXT_CHARS),
                },
            },
        }));

        const command = new RerankCommand({
            queries: [{
                type: 'TEXT',
                textQuery: { text: query.slice(0, MAX_TEXT_CHARS) },
            }],
            sources,
            rerankingConfiguration: {
                type: 'BEDROCK_RERANKING_MODEL',
                bedrockRerankingConfiguration: {
                    modelConfiguration: { modelArn: this.modelArn },
                    numberOfResults:    topK,
                },
            },
        });

        const response = await this.client.send(command);
        const results  = response.results ?? [];

        const out: RerankResult[] = [];
        for (const r of results) {
            const idx = r.index;
            if (idx === undefined || idx < 0 || idx >= candidates.length) continue;
            out.push({
                id:             candidates[idx].id,
                relevanceScore: r.relevanceScore ?? 0,
                originalIndex:  idx,
            });
        }
        return out;
    }
}
