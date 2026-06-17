/**
 * @format
 * Environment variable parser for the ingestion K8s Job.
 * Validates required vars at startup; throws on missing.
 */

export interface IngestionEnv {
    readonly userId:                   string;
    readonly repoFullName:             string;
    /**
     * Immutable GitHub numeric repo id, when the dispatcher knows it (set on the
     * job spec by tucaken-app post-backfill). Null on legacy/pre-backfill runs —
     * the worker then skips rename self-heal and writes NULL into the
     * `github_repo_id` dual-write columns.
     */
    readonly githubRepoId:             number | null;
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

/**
 * Parse an optional immutable GitHub repo id. Returns a finite positive integer
 * or null (absent, blank, or invalid) — an invalid id must not crash the run;
 * we simply fall back to the legacy name-only path.
 */
function optionalGithubRepoId(): number | null {
    const raw = process.env['GITHUB_REPO_ID'];
    if (!raw) return null;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n;
}

export function parseEnv(): IngestionEnv {
    return {
        userId:                  required('USER_ID'),
        repoFullName:            required('REPO_FULL_NAME'),
        githubRepoId:            optionalGithubRepoId(),
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
