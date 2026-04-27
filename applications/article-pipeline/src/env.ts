/**
 * @format
 * Environment variable parsing for the article pipeline K8s Job.
 *
 * The Job is dispatched by admin-api with a per-run set of env vars.
 * Required: PIPELINE_RUN_ID, SLUG, S3_BUCKET, S3_SOURCE_KEY, PG_*.
 * Optional with defaults: MODE, PIPELINE_ID.
 */
export interface PipelineEnv {
    readonly pipelineRunId: string;
    readonly slug:          string;
    readonly s3Bucket:      string;
    readonly s3SourceKey:   string;
    readonly mode:          string;
    readonly pipelineId:    string;
    readonly environment:   string;
    readonly pg: {
        readonly host:     string;
        readonly port:     number;
        readonly database: string;
        readonly user:     string;
        readonly password: string;
    };
}

function required(name: string): string {
    const v = process.env[name];
    if (!v) throw new Error(`Missing required env var: ${name}`);
    return v;
}

export function parseEnv(): PipelineEnv {
    const pipelineRunId = required('PIPELINE_RUN_ID');
    return {
        pipelineRunId,
        slug:        required('SLUG'),
        s3Bucket:    required('S3_BUCKET'),
        s3SourceKey: required('S3_SOURCE_KEY'),
        mode:        process.env['MODE']        ?? 'standard',
        pipelineId:  process.env['PIPELINE_ID'] ?? pipelineRunId,
        environment: process.env['ENVIRONMENT'] ?? 'production',
        pg: {
            host:     required('PG_HOST'),
            port:     parseInt(process.env['PG_PORT'] ?? '5432', 10),
            database: required('PG_DATABASE'),
            user:     required('PG_USER'),
            password: required('PG_PASSWORD'),
        },
    };
}
