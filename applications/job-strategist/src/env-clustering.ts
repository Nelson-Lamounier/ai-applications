/**
 * @format
 * Environment variable parsing for the Project Clustering K8s Job
 * entrypoint. Dispatched by admin-api with a per-run set of env vars.
 */
export interface ClusteringEnv {
    readonly pipelineRunId: string;
    readonly userId:        string;
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

export function parseClusteringEnv(): ClusteringEnv {
    return {
        pipelineRunId: required('CLUSTERING_PIPELINE_RUN_ID'),
        userId:        required('USER_ID'),
        environment:   process.env['ENVIRONMENT'] ?? 'production',
        pg: {
            host:     required('PG_HOST'),
            port:     parseInt(process.env['PG_PORT'] ?? '5432', 10),
            database: required('PG_DATABASE'),
            user:     required('PG_USER'),
            password: required('PG_PASSWORD'),
        },
    };
}
