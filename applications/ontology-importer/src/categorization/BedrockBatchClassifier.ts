/** @format */
import { BedrockClient, CreateModelInvocationJobCommand, GetModelInvocationJobCommand, StopModelInvocationJobCommand } from '@aws-sdk/client-bedrock';
import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import type { RawImportEntry, OntologyCategory, CategorizationResult } from '@bedrock/shared';
import { ONTOLOGY_CATEGORIES } from '@bedrock/shared';

export const MODEL_ID_DEFAULT = 'anthropic.claude-haiku-4-5-20251001-v1:0';

/** A Bedrock batch input record. modelInput is the Anthropic Messages body. */
export interface BatchRecord {
    recordId: string;
    modelInput: Record<string, unknown>;
}
export interface PooledItem {
    entry: RawImportEntry;
    ecosystem: string;
}
export type RecordMap = Record<string, { ecosystem: string; identifier: string }>;

const SYSTEM = [
    {
        type: 'text',
        text:
            'You categorize software packages for a developer-resume system. ' +
            'Decide if a package is technology-worthy (yes/no/maybe) and pick exactly one category.',
    },
];

const TOOL = {
    name: 'classify_package',
    description: 'Record the classification decision for a package.',
    input_schema: {
        type: 'object',
        properties: {
            decision: { type: 'string', enum: ['yes', 'no', 'maybe'] },
            category: { type: ['string', 'null'], enum: [...ONTOLOGY_CATEGORIES, null] },
            reasoning: { type: 'string', maxLength: 200 },
        },
        required: ['decision', 'category', 'reasoning'],
        additionalProperties: false,
    },
};

function recordIdFor(index: number): string {
    return `r${String(index).padStart(7, '0')}`;
}

/** Pure: pool entries across sources into Bedrock batch records + a recordId→entry map. */
export function buildJsonlRecords(items: PooledItem[]): { records: BatchRecord[]; recordMap: RecordMap } {
    const records: BatchRecord[] = [];
    const recordMap: RecordMap = {};
    items.forEach(({ entry, ecosystem }, i) => {
        const recordId = recordIdFor(i + 1);
        recordMap[recordId] = { ecosystem, identifier: entry.source_identifier };
        records.push({
            recordId,
            modelInput: {
                anthropic_version: 'bedrock-2023-05-31',
                max_tokens: 256,
                system: SYSTEM,
                tools: [TOOL],
                tool_choice: { type: 'tool', name: 'classify_package' },
                messages: [
                    {
                        role: 'user',
                        content:
                            `Package: ${entry.source_identifier}\n` +
                            `Ecosystem: ${ecosystem}\n` +
                            `Description: ${entry.description ?? '(none)'}\n` +
                            `Keywords: ${(entry.keywords ?? []).join(', ') || '(none)'}`,
                    },
                ],
            },
        });
    });
    return { records, recordMap };
}

/** Pure: extract the classify_package tool_use from a Bedrock output record. */
export function parseModelOutput(record: {
    recordId: string;
    modelOutput?: { content?: Array<{ type: string; name?: string; input?: unknown }> };
}): { recordId: string } & Pick<CategorizationResult, 'decision' | 'category' | 'reasoning'> {
    const tu = (record.modelOutput?.content ?? []).find((b) => b.type === 'tool_use' && b.name === 'classify_package');
    if (!tu?.input) return { recordId: record.recordId, decision: 'maybe', category: null, reasoning: 'no tool_use' };
    const i = tu.input as { decision?: string; category?: string | null; reasoning?: string };
    return {
        recordId: record.recordId,
        decision: (i.decision as 'yes' | 'no' | 'maybe') ?? 'maybe',
        category: (i.category as OntologyCategory | null) ?? null,
        reasoning: i.reasoning,
    };
}

/** Pure: coerce a candidate jobName to Bedrock's CreateModelInvocationJob constraint.
 *  Pattern: /[a-zA-Z0-9]{1,63}(-*[a-zA-Z0-9+\-.]){0,63}/ — no underscores, no spaces.
 *  Illegal characters become '-'; final string is capped at 63 chars. */
export function sanitizeJobName(candidate: string): string {
    return candidate.replace(/[^a-zA-Z0-9+\-.]/g, '-').slice(0, 63);
}

export interface BedrockBatchConfig {
    region: string;
    bucket: string;
    prefix: string;     // e.g. 'batch'
    roleArn: string;    // Bedrock batch service role
    modelId: string;
}

/** Thin AWS shell (mocked in tests; pure functions above carry the logic). */
export class BedrockBatchClassifier {
    private readonly bedrock: BedrockClient;
    private readonly s3: S3Client;
    constructor(private readonly cfg: BedrockBatchConfig) {
        this.bedrock = new BedrockClient({ region: cfg.region });
        this.s3 = new S3Client({ region: cfg.region });
    }

    /** Write records as one JSONL to S3 and create the batch job. Returns the job ARN. */
    async submit(records: BatchRecord[], runKey: string): Promise<string> {
        const inputKey = `${this.cfg.prefix}/input/${runKey}.jsonl`;
        const body = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
        await this.s3.send(new PutObjectCommand({ Bucket: this.cfg.bucket, Key: inputKey, Body: body, ContentType: 'application/jsonl' }));
        const res = await this.bedrock.send(new CreateModelInvocationJobCommand({
            jobName: sanitizeJobName(`ontology-importer-${runKey}`),
            roleArn: this.cfg.roleArn,
            modelId: this.cfg.modelId,
            inputDataConfig: { s3InputDataConfig: { s3Uri: `s3://${this.cfg.bucket}/${inputKey}`, s3InputFormat: 'JSONL' } },
            outputDataConfig: { s3OutputDataConfig: { s3Uri: `s3://${this.cfg.bucket}/${this.cfg.prefix}/output/${runKey}/` } },
        }));
        if (!res.jobArn) throw new Error('CreateModelInvocationJob returned no jobArn');
        return res.jobArn;
    }

    async retrieve(jobArn: string): Promise<{ status: string }> {
        const res = await this.bedrock.send(new GetModelInvocationJobCommand({ jobIdentifier: jobArn }));
        return { status: res.status ?? 'Unknown' };
    }

    async stop(jobArn: string): Promise<void> {
        await this.bedrock.send(new StopModelInvocationJobCommand({ jobIdentifier: jobArn }));
    }

    /** Read + parse the output JSONL(s) for a completed job under prefix/output/<runKey>/. */
    async *readResults(runKey: string): AsyncIterable<{ recordId: string; modelOutput?: { content?: Array<{ type: string; name?: string; input?: unknown }> } }> {
        const outPrefix = `${this.cfg.prefix}/output/${runKey}/`;
        const listed = await this.s3.send(new ListObjectsV2Command({ Bucket: this.cfg.bucket, Prefix: outPrefix }));
        for (const obj of listed.Contents ?? []) {
            if (!obj.Key || !obj.Key.endsWith('.jsonl.out')) continue;
            const got = await this.s3.send(new GetObjectCommand({ Bucket: this.cfg.bucket, Key: obj.Key }));
            const text = await got.Body!.transformToString();
            for (const line of text.split('\n')) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                try { yield JSON.parse(trimmed); } catch { /* skip malformed line */ }
            }
        }
    }
}
