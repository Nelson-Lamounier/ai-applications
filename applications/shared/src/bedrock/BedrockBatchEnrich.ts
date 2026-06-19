/**
 * @format
 * BedrockBatchEnrich — submit per-file enrichment calls as a Bedrock batch
 * (feature 002, US3). Ports the proven BedrockBatchClassifier shell (S3 JSONL →
 * CreateModelInvocationJob → poll → read output JSONL) but reuses the SHARED
 * extraction body + parser from BedrockChunkEnricher, so a batched call is
 * byte-identical to the inline one — the batch lever is cost-only.
 *
 * Bedrock batch bills ~50% of on-demand. It is async (minutes), so this is for
 * the background re-enrich / ingestion Jobs, never the request path. Fail-safe:
 * any error here is thrown to the caller, which falls back to inline enrichText.
 */
import { BedrockClient, CreateModelInvocationJobCommand, GetModelInvocationJobCommand } from '@aws-sdk/client-bedrock';
import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';

import { buildExtractionBody, parseExtractionSkills } from '../rds/implementations/extractionBody.js';

/**
 * One thing to enrich in a batch — granularity-agnostic. `id` is the caller's
 * key to map results back: a chunk id (`filePath::chunkIndex`) for the per-chunk
 * lever, or a file path for the (gated-off) per-file lever.
 */
export interface BatchEnrichItem {
    id: string;
    filePath: string;
    content: string;
    heading?: string;
}

/** A Bedrock batch input record. modelInput is the Anthropic Messages body. */
export interface BatchEnrichRecord {
    recordId: string;
    modelInput: Record<string, unknown>;
}

export interface BedrockBatchEnrichConfig {
    region: string;
    bucket: string;
    prefix: string;     // e.g. 'enrich-batch'
    roleArn: string;    // Bedrock batch service role
    modelId: string;
}

function recordIdFor(index: number): string {
    return `r${String(index).padStart(7, '0')}`;
}

/** Coerce to Bedrock's jobName constraint: [a-zA-Z0-9+\-.], ≤63 chars, no underscores/spaces. */
export function sanitizeJobName(candidate: string): string {
    return candidate.replace(/[^a-zA-Z0-9+\-.]/g, '-').slice(0, 63);
}

/** Pure: one batch record per item + a recordId→item-id map (granularity-agnostic). */
export function buildEnrichRecords(items: readonly BatchEnrichItem[]): {
    records: BatchEnrichRecord[];
    recordToId: Record<string, string>;
} {
    const records: BatchEnrichRecord[] = [];
    const recordToId: Record<string, string> = {};
    items.forEach((item, i) => {
        const recordId = recordIdFor(i + 1);
        recordToId[recordId] = item.id;
        records.push({ recordId, modelInput: buildExtractionBody(item.filePath, item.content, item.heading) });
    });
    return { records, recordToId };
}

interface OutputRecord {
    recordId: string;
    modelOutput?: { content?: Array<{ type: string; name?: string; input?: { skills?: unknown[] } }> };
}

/** Thin AWS shell (mocked in tests; pure functions above carry the logic). */
export class BedrockBatchEnrich {
    private readonly bedrock: BedrockClient;
    private readonly s3: S3Client;
    constructor(private readonly cfg: BedrockBatchEnrichConfig) {
        this.bedrock = new BedrockClient({ region: cfg.region });
        this.s3 = new S3Client({ region: cfg.region });
    }

    /** Write records as one JSONL to S3 and create the batch job. Returns the job ARN. */
    async submit(records: BatchEnrichRecord[], runKey: string): Promise<string> {
        const inputKey = `${this.cfg.prefix}/input/${runKey}.jsonl`;
        const body = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
        await this.s3.send(new PutObjectCommand({ Bucket: this.cfg.bucket, Key: inputKey, Body: body, ContentType: 'application/jsonl' }));
        const res = await this.bedrock.send(new CreateModelInvocationJobCommand({
            jobName: sanitizeJobName(`enrich-${runKey}`),
            roleArn: this.cfg.roleArn,
            modelId: this.cfg.modelId,
            inputDataConfig:  { s3InputDataConfig: { s3Uri: `s3://${this.cfg.bucket}/${inputKey}`, s3InputFormat: 'JSONL' } },
            outputDataConfig: { s3OutputDataConfig: { s3Uri: `s3://${this.cfg.bucket}/${this.cfg.prefix}/output/${runKey}/` } },
        }));
        if (!res.jobArn) throw new Error('CreateModelInvocationJob returned no jobArn');
        return res.jobArn;
    }

    async status(jobArn: string): Promise<string> {
        const res = await this.bedrock.send(new GetModelInvocationJobCommand({ jobIdentifier: jobArn }));
        return res.status ?? 'Unknown';
    }

    /** Read + parse output JSONL(s) → recordId → raw (un-canonicalised) skills. */
    async collect(runKey: string): Promise<Map<string, unknown[]>> {
        const out = new Map<string, unknown[]>();
        const outPrefix = `${this.cfg.prefix}/output/${runKey}/`;
        const listed = await this.s3.send(new ListObjectsV2Command({ Bucket: this.cfg.bucket, Prefix: outPrefix }));
        for (const obj of listed.Contents ?? []) {
            if (!obj.Key?.endsWith('.jsonl.out')) continue;
            const got = await this.s3.send(new GetObjectCommand({ Bucket: this.cfg.bucket, Key: obj.Key }));
            const text = await got.Body!.transformToString();
            for (const line of text.split('\n')) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                try {
                    const rec = JSON.parse(trimmed) as OutputRecord;
                    out.set(rec.recordId, parseExtractionSkills(rec.modelOutput?.content ?? []));
                } catch { /* skip malformed line — collect what we can */ }
            }
        }
        return out;
    }
}
