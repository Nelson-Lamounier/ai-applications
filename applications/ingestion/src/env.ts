/**
 * @format
 * Environment variable parser for the ingestion K8s Job.
 * Validates required vars at startup; throws on missing.
 */

export interface IngestionEnv {
    readonly userId:                   string;
    readonly repoFullName:             string;
    readonly forceReindex:             boolean;
    readonly githubToken:              string;
    readonly profileExtractorModelId:  string;
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

export function parseEnv(): IngestionEnv {
    return {
        userId:                  required('USER_ID'),
        repoFullName:            required('REPO_FULL_NAME'),
        forceReindex:            (process.env['FORCE_REINDEX'] ?? 'false').toLowerCase() === 'true',
        githubToken:             required('GITHUB_TOKEN'),
        profileExtractorModelId: process.env['PROFILE_EXTRACTOR_MODEL_ID']
            ?? 'eu.anthropic.claude-haiku-4-5-20251001-v1:0',
        pg: {
            host:     required('PG_HOST'),
            port:     Number.parseInt(process.env['PG_PORT'] ?? '5432', 10),
            database: required('PG_DATABASE'),
            user:     required('PG_USER'),
            password: required('PG_PASSWORD'),
        },
    };
}
