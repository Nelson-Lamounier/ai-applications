/**
 * @format
 * Environment variable parsing for the Project Case-Study K8s Job
 * entrypoint. Dispatched by admin-api one project at a time.
 */
export interface CaseStudyEnv {
    readonly pipelineRunId: string;
    readonly projectId:     string;
    readonly userId:        string;
    readonly githubToken:   string;
    readonly model:         string;
    readonly kbVersion:     string;
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

export function parseCaseStudyEnv(): CaseStudyEnv {
    return {
        pipelineRunId: required('CASE_STUDY_PIPELINE_RUN_ID'),
        projectId:     required('PROJECT_ID'),
        userId:        required('USER_ID'),
        githubToken:   required('GITHUB_TOKEN'),
        model:         process.env.CASE_STUDY_MODEL
                       ?? 'eu.anthropic.claude-sonnet-4-6',
        kbVersion:     process.env.KB_VERSION ?? 'kb-v1',
        environment:   process.env.ENVIRONMENT ?? 'production',
        pg: {
            host:     required('PG_HOST'),
            port:     parseInt(process.env.PG_PORT ?? '5432', 10),
            database: required('PG_DATABASE'),
            user:     required('PG_USER'),
            password: required('PG_PASSWORD'),
        },
    };
}
