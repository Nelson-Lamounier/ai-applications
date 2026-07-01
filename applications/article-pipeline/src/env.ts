/**
 * @format
 * Environment variable parsing for the article pipeline K8s Job.
 *
 * The Job is dispatched by admin-api with a per-run set of env vars.
 * Required: PIPELINE_RUN_ID, SLUG, S3_BUCKET, S3_SOURCE_KEY, PG_*, USER_ID.
 * Optional with defaults: MODE, PIPELINE_ID.
 */
/** A measured number the author confirmed for a topic — safe for the Writer to cite (Gap 3). */
export interface BriefVerifiedMetric {
    readonly label:   string;
    readonly value:   string;
    readonly unit?:   string;
    readonly source?: string;
}

/**
 * Structured article brief, carried from a chosen topic candidate via the
 * ARTICLE_BRIEF env var (JSON). Replaces the bare short prompt: it names the
 * narrow problem/angle and carries author-confirmed verified metrics so real
 * numbers survive the anti-fabrication rail. Absent for draft-only dispatches.
 */
export interface ArticleBrief {
    readonly problem?:         string;
    readonly angle?:           string;
    readonly primaryKeyword?:  string;
    readonly verifiedMetrics?: readonly BriefVerifiedMetric[];
}

export interface PipelineEnv {
    readonly userId:       string;
    readonly pipelineRunId: string;
    readonly slug:          string;
    readonly s3Bucket:      string;
    readonly s3SourceKey:   string;
    readonly mode:          string;
    readonly pipelineId:    string;
    readonly environment:   string;
    /** Structured brief from a chosen topic candidate (JSON in ARTICLE_BRIEF); undefined for draft-only runs. */
    readonly articleBrief?: ArticleBrief;
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

/** Parse the optional ARTICLE_BRIEF env var; malformed JSON is ignored (fail-open to draft-only). */
export function parseArticleBrief(): ArticleBrief | undefined {
    const raw = process.env['ARTICLE_BRIEF'];
    if (!raw) return undefined;
    try {
        const parsed = JSON.parse(raw) as ArticleBrief;
        return typeof parsed === 'object' && parsed !== null ? parsed : undefined;
    } catch {
        return undefined; // a broken brief must not fail the run; fall back to draft-only
    }
}

export function parseEnv(): PipelineEnv {
    const pipelineRunId = required('PIPELINE_RUN_ID');
    return {
        articleBrief: parseArticleBrief(),
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
