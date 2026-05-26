/** @format */

export type TriggeredBy = 'cronjob' | 'manual' | 'backfill';

export interface OntologyImportEnv {
    readonly pg: {
        readonly host: string; readonly port: number; readonly database: string;
        readonly user: string; readonly password: string;
    };
    readonly bedrock: {
        readonly region:    string;
        readonly modelId:   string;
        readonly bucket:    string;
        readonly prefix:    string;
        readonly roleArn:   string;
        readonly minRecords: number;
    };
    readonly triggeredBy:          TriggeredBy;
    readonly deactivationThreshold: number;
    readonly sources?:             string[];
}

function required(name: string): string {
    const v = process.env[name];
    if (!v) throw new Error(`Missing required env var: ${name}`);
    return v;
}

function parseTriggeredBy(raw: string): TriggeredBy {
    if (raw === 'cronjob' || raw === 'manual' || raw === 'backfill') return raw;
    throw new Error(`Invalid TRIGGERED_BY: ${raw} (expected cronjob|manual|backfill)`);
}

export function parseEnv(): OntologyImportEnv {
    const sourcesRaw = process.env['SOURCES'];
    const sources = sourcesRaw ? sourcesRaw.split(',').map((s) => s.trim()).filter(Boolean) : undefined;

    return {
        pg: {
            host:     required('PG_HOST'),
            port:     Number.parseInt(process.env['PG_PORT'] ?? '5432', 10),
            database: required('PG_DATABASE'),
            user:     required('PG_USER'),
            password: required('PG_PASSWORD'),
        },
        bedrock: {
            region:     process.env['AWS_REGION'] ?? 'eu-west-1',
            modelId:    process.env['BEDROCK_MODEL_ID'] ?? 'anthropic.claude-haiku-4-5-20251001-v1:0',
            bucket:     required('BATCH_S3_BUCKET'),
            prefix:     process.env['BATCH_S3_PREFIX'] ?? 'batch',
            roleArn:    required('BEDROCK_BATCH_ROLE_ARN'),
            minRecords: Number.parseInt(process.env['MIN_BATCH_RECORDS'] ?? '100', 10),
        },
        triggeredBy:           parseTriggeredBy(process.env['TRIGGERED_BY'] ?? 'cronjob'),
        deactivationThreshold: Number.parseInt(process.env['DEACTIVATION_THRESHOLD'] ?? '3', 10),
        sources,
    };
}
