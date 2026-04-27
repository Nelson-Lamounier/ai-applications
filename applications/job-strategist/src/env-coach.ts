/**
 * @format
 * Environment variable parsing for the Coach K8s Job entrypoint.
 *
 * Dispatched by admin-api with a per-run set of env vars. The coach Job
 * is a separate entrypoint from the Strategist analysis Job (run-pipeline)
 * because it loads previously-persisted analysis from pipeline_runs.metadata
 * rather than re-running Research+Strategist.
 */
export interface CoachEnv {
    readonly coachPipelineRunId:      string;  // this run's id (UPDATE this row)
    readonly strategistPipelineRunId: string;  // source of analysis JSON
    readonly applicationId:           string;
    readonly applicationSlug:         string;
    readonly userId:                  string;
    readonly targetCompany:           string;
    readonly targetRole:              string;
    readonly jobDescription:          string;
    readonly interviewStage:          string;
    readonly mode:                    string;
    readonly version:                 number;
    readonly environment:             string;
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

export function parseCoachEnv(): CoachEnv {
    return {
        coachPipelineRunId:      required('COACH_PIPELINE_RUN_ID'),
        strategistPipelineRunId: required('STRATEGIST_PIPELINE_RUN_ID'),
        applicationId:           required('APPLICATION_ID'),
        applicationSlug:         required('APPLICATION_SLUG'),
        userId:                  required('USER_ID'),
        targetCompany:           required('TARGET_COMPANY'),
        targetRole:              required('TARGET_ROLE'),
        jobDescription:          required('JOB_DESCRIPTION'),
        interviewStage:          required('INTERVIEW_STAGE'),
        mode:                    process.env['MODE']        ?? 'standard',
        version:                 parseInt(process.env['PIPELINE_VERSION'] ?? '1', 10),
        environment:             process.env['ENVIRONMENT'] ?? 'production',
        pg: {
            host:     required('PG_HOST'),
            port:     parseInt(process.env['PG_PORT'] ?? '5432', 10),
            database: required('PG_DATABASE'),
            user:     required('PG_USER'),
            password: required('PG_PASSWORD'),
        },
    };
}
