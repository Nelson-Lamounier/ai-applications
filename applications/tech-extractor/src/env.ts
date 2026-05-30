/** @format */

export interface TechExtractEnv {
    readonly userId:       string;
    readonly repoFullName: string;
    readonly commitSha?:   string;
    readonly githubToken:  string;
    readonly workDir:      string;
    readonly pg: {
        readonly host: string; readonly port: number; readonly database: string;
        readonly user: string; readonly password: string;
    };
}

function required(name: string): string {
    const v = process.env[name];
    if (!v) throw new Error(`Missing required env var: ${name}`);
    return v;
}

export function parseEnv(): TechExtractEnv {
    return {
        userId:       required('USER_ID'),
        repoFullName: required('REPO_FULL_NAME'),
        commitSha:    process.env['COMMIT_SHA'] || undefined,
        githubToken:  required('GITHUB_TOKEN'),
        workDir:      process.env['WORK_DIR'] ?? '/work',
        pg: {
            host:     required('PG_HOST'),
            port:     Number.parseInt(process.env['PG_PORT'] ?? '5432', 10),
            database: required('PG_DATABASE'),
            user:     required('PG_USER'),
            password: required('PG_PASSWORD'),
        },
    };
}
