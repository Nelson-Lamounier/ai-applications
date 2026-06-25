/**
 * @format
 * Environment variable parsing for the article pipeline K8s Job.
 *
 * The Job is dispatched by admin-api with a per-run set of env vars.
 * Required: PIPELINE_RUN_ID, SLUG, S3_BUCKET, S3_SOURCE_KEY, PG_*, USER_ID.
 * Optional with defaults: MODE, PIPELINE_ID.
 */
export interface PipelineEnv {
    readonly userId:       string;
    readonly pipelineRunId: string;
    readonly slug:          string;
    readonly s3Bucket:      string;
    readonly s3SourceKey:   string;
    readonly mode:          string;
    readonly pipelineId:    string;
    readonly environment:   string;
    /**
     * Writer-agent foundation model id, recorded as articles.ai_model for
     * provenance. Mirrors the writer-agent's own fallback so the persisted value
     * is exactly the model that generated the content.
     */
    readonly foundationModel: string;
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
        userId:       required('USER_ID'),
        pipelineRunId,
        slug:        required('SLUG'),
        s3Bucket:    required('S3_BUCKET'),
        s3SourceKey: required('S3_SOURCE_KEY'),
        mode:        process.env['MODE']        ?? 'standard',
        pipelineId:  process.env['PIPELINE_ID'] ?? pipelineRunId,
        environment: process.env['ENVIRONMENT'] ?? 'production',
        // Mirror writer-agent.ts WRITER_MODEL fallback so ai_model records the
        // exact model that wrote the article, even when FOUNDATION_MODEL is unset.
        foundationModel: process.env['FOUNDATION_MODEL'] ?? 'eu.anthropic.claude-sonnet-4-6',
        pg: {
            host:     required('PG_HOST'),
            port:     Number.parseInt(process.env['PG_PORT'] ?? '5432', 10),
            database: required('PG_DATABASE'),
            user:     required('PG_USER'),
            password: required('PG_PASSWORD'),
        },
    };
}
