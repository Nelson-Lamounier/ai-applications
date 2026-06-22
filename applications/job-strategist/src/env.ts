/**
 * @format
 * Environment variable parsing for the Strategist analysis K8s Job.
 *
 * The Job is dispatched by admin-api with a per-run set of env vars.
 * Required: PIPELINE_RUN_ID, APPLICATION_ID, APPLICATION_SLUG, USER_ID,
 *           TARGET_COMPANY, TARGET_ROLE, JOB_DESCRIPTION, PG_*.
 * Optional with defaults: MODE, PIPELINE_ID, PIPELINE_VERSION, ENVIRONMENT.
 */
export interface StrategistEnv {
    readonly pipelineRunId:    string;
    readonly applicationId:    string;
    readonly applicationSlug:  string;
    readonly userId:           string;
    readonly targetCompany:    string;
    readonly targetRole:       string;
    readonly jobDescription:   string;
    readonly resumeId:         string;
    readonly mode:             string;     // PipelineMode-compatible
    readonly pipelineId:       string;
    readonly version:          number;
    readonly environment:      string;
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

/** Returns true when the pipeline is running in free-tier mode. */
export const isFreeMode = (env: { mode: string }): boolean => env.mode === 'free';

export function parseEnv(): StrategistEnv {
    const pipelineRunId = required('PIPELINE_RUN_ID');
    return {
        pipelineRunId,
        applicationId:   required('APPLICATION_ID'),
        applicationSlug: required('APPLICATION_SLUG'),
        userId:          required('USER_ID'),
        targetCompany:   required('TARGET_COMPANY'),
        targetRole:      required('TARGET_ROLE'),
        jobDescription:  required('JOB_DESCRIPTION'),
        resumeId:        process.env['RESUME_ID'] ?? '',
        mode:            process.env['MODE']             ?? 'standard',
        pipelineId:      process.env['PIPELINE_ID']      ?? pipelineRunId,
        version:         parseInt(process.env['PIPELINE_VERSION'] ?? '1', 10),
        environment:     process.env['ENVIRONMENT']      ?? 'production',
        pg: {
            host:     required('PG_HOST'),
            port:     parseInt(process.env['PG_PORT'] ?? '5432', 10),
            database: required('PG_DATABASE'),
            user:     required('PG_USER'),
            password: required('PG_PASSWORD'),
        },
    };
}
