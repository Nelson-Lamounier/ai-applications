/**
 * @format
 * Orchestrator — job-strategist end-to-end integration test.
 *
 * Automates the full local test flow in a single command:
 *   1. Read PG credentials from Kubernetes secret (no AWS Secrets Manager needed)
 *   2. Start kubectl port-forward (pgbouncer → localhost:15432) as a managed child process
 *   3. Wait for the DB port to become reachable
 *   4. Build TypeScript (shared + job-strategist) into dist/
 *   5. Run jest integration test suite
 *   6. Kill port-forward and exit with jest's exit code
 *
 * Prerequisites:
 *   - kubectl configured for the target cluster (kubeconfig / KUBECONFIG)
 *   - AWS credentials in env (default credential chain — profile, SSO, instance role)
 *   - npx tsx available (devDependency in root package.json)
 *
 * Usage (from repo root):
 *   npx tsx scripts/test-strategist-integration.ts
 *
 * Env overrides:
 *   PF_PORT          Local port for pgbouncer forward   (default: 15432)
 *   PF_NAMESPACE     Namespace of pgbouncer service     (default: platform)
 *   PG_USER          PG username override               (default: from k8s secret)
 *   PG_PASSWORD      PG password override               (default: from k8s secret)
 *   PG_DATABASE      PG database name override          (default: from k8s secret)
 *   TEST_USER_ID     User with document_embeddings      (default: resolved from cluster)
 *   RESEARCH_MODEL   Bedrock model for research agent   (default: haiku-4-5 cross-region ARN)
 *   AWS_REGION       AWS region for Bedrock calls       (default: eu-west-1)
 *   SKIP_CLEANUP     Set to '1' to preserve RDS rows    (default: 0)
 *   SKIP_BUILD       Set to '1' to skip tsc build       (default: 0)
 */

import { spawnSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync }                          from 'node:fs';
import { createConnection }                    from 'node:net';
import path                                    from 'node:path';

// =============================================================================
// CONFIG
// =============================================================================

const REPO_ROOT    = process.cwd();
const PF_PORT      = Number(process.env['PF_PORT']      ?? '15432');
const PF_NS        = process.env['PF_NAMESPACE']        ?? 'platform';
const AWS_REGION   = process.env['AWS_REGION']          ?? 'eu-west-1';
const SKIP_BUILD   = process.env['SKIP_BUILD']          === '1';
const SKIP_CLEANUP = process.env['SKIP_CLEANUP']        ?? '0';

const RESEARCH_MODEL =
    process.env['RESEARCH_MODEL'] ??
    'eu.anthropic.claude-haiku-4-5-20251001-v1:0';

// =============================================================================
// LOGGING
// =============================================================================

const RESET  = '\x1b[0m';
const BOLD   = '\x1b[1m';
const GREEN  = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED    = '\x1b[31m';
const CYAN   = '\x1b[36m';
const DIM    = '\x1b[2m';

function step(n: number, total: number, msg: string): void {
    console.log(`\n${BOLD}${CYAN}[${n}/${total}]${RESET} ${BOLD}${msg}${RESET}`);
}

function ok(msg: string):   void { console.log(`  ${GREEN}✓${RESET} ${msg}`); }
function warn(msg: string): void { console.log(`  ${YELLOW}⚠${RESET}  ${msg}`); }
function fail(msg: string): void { console.error(`  ${RED}✗${RESET} ${msg}`); }
function dim(msg: string):  void { console.log(`  ${DIM}${msg}${RESET}`); }

// =============================================================================
// KUBECTL HELPERS
// =============================================================================

interface RdsCredentials {
    pgUser:     string;
    pgPassword: string;
    pgDatabase: string;
}

function readK8sSecret(name: string, namespace: string): Record<string, string> {
    // Use spawn (array args) — no shell interpolation, immune to injection.
    // -o json avoids jsonpath quoting differences across shells/platforms.
    const result = spawnSync(
        'kubectl',
        ['get', 'secret', name, '-n', namespace, '-o', 'json'],
        { encoding: 'utf8' },
    );

    if (result.status !== 0) {
        throw new Error(
            `kubectl get secret failed (exit ${result.status ?? 'null'}):\n${result.stderr}`,
        );
    }

    const parsed = JSON.parse(result.stdout) as { data: Record<string, string> };
    return Object.fromEntries(
        Object.entries(parsed.data ?? {}).map(
            ([k, v]) => [k, Buffer.from(v, 'base64').toString('utf8')],
        ),
    );
}

function resolveCredentials(): RdsCredentials {
    if (process.env['PG_PASSWORD']) {
        dim('Using PG credentials from environment variables');
        return {
            pgUser:     process.env['PG_USER']     ?? 'postgres',
            pgPassword: process.env['PG_PASSWORD'],
            pgDatabase: process.env['PG_DATABASE'] ?? 'tucaken',
        };
    }

    dim(`Reading credentials from k8s secret platform-rds-credentials (ns: ${PF_NS})`);
    const secret = readK8sSecret('platform-rds-credentials', PF_NS);

    const pgPassword = secret['PG_PASSWORD'] ?? '';
    if (!pgPassword) {
        throw new Error(
            'PG_PASSWORD not found in platform-rds-credentials secret.\n' +
            'Override with: PG_PASSWORD=<value> npx tsx scripts/test-strategist-integration.ts',
        );
    }

    return {
        pgUser:     secret['PG_USER']     ?? 'postgres',
        pgPassword,
        pgDatabase: secret['PG_DATABASE'] ?? 'tucaken',
    };
}

// =============================================================================
// AWS CREDENTIALS
// =============================================================================

function resolveAwsCredentials(): Record<string, string> {
    // If explicit key vars are already set (e.g. CI, env export), use them directly.
    if (process.env['AWS_ACCESS_KEY_ID'] && process.env['AWS_SECRET_ACCESS_KEY']) {
        dim('Using AWS credentials from environment variables');
        const creds: Record<string, string> = {
            AWS_ACCESS_KEY_ID:     process.env['AWS_ACCESS_KEY_ID'],
            AWS_SECRET_ACCESS_KEY: process.env['AWS_SECRET_ACCESS_KEY'],
        };
        if (process.env['AWS_SESSION_TOKEN']) {
            creds['AWS_SESSION_TOKEN'] = process.env['AWS_SESSION_TOKEN'];
        }
        return creds;
    }

    // Fall back to aws configure export-credentials (handles SSO, profiles, instance roles).
    const awsProfile = process.env['AWS_PROFILE'] ?? 'dev-account';
    dim(`Exporting AWS credentials via \`aws configure export-credentials\` (profile: ${awsProfile})`);
    const result = spawnSync(
        'aws',
        ['configure', 'export-credentials', '--format', 'env-no-export', '--profile', awsProfile],
        { encoding: 'utf8' },
    );

    if (result.status !== 0) {
        throw new Error(
            `Failed to export AWS credentials (exit ${result.status ?? 'null'}):\n${result.stderr}\n` +
            'Ensure you are logged in: aws sso login --profile <profile>',
        );
    }

    const creds: Record<string, string> = {};
    for (const line of result.stdout.split('\n')) {
        const eqIdx = line.indexOf('=');
        if (eqIdx === -1) continue;
        const key = line.slice(0, eqIdx).trim();
        const val = line.slice(eqIdx + 1).trim();
        if (key && val) creds[key] = val;
    }

    if (!creds['AWS_ACCESS_KEY_ID']) {
        throw new Error(
            'AWS_ACCESS_KEY_ID not found in export-credentials output. ' +
            'Ensure you are authenticated: aws sso login',
        );
    }

    ok(`AWS credentials resolved (access key: ${creds['AWS_ACCESS_KEY_ID']?.slice(0, 8)}...)`);
    return creds;
}

// =============================================================================
// PORT-FORWARD
// =============================================================================

function startPortForward(): ChildProcess {
    const pf = spawn(
        'kubectl',
        ['port-forward', 'svc/pgbouncer', `${PF_PORT}:5432`, '-n', PF_NS],
        { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    pf.stdout?.on('data', (d: Buffer) => {
        const line = d.toString().trim();
        if (line) dim(`[port-forward] ${line}`);
    });
    pf.stderr?.on('data', (d: Buffer) => {
        const line = d.toString().trim();
        if (line && !line.startsWith('Forwarding from')) dim(`[port-forward:err] ${line}`);
    });
    pf.on('exit', (code, signal) => {
        if (signal !== 'SIGTERM' && signal !== 'SIGKILL') {
            warn(`port-forward exited unexpectedly (code=${code ?? 'null'} signal=${signal ?? 'none'})`);
        }
    });

    return pf;
}

function waitForPort(host: string, port: number, timeoutMs = 20_000): Promise<void> {
    const start = Date.now();
    return new Promise((resolve, reject) => {
        const attempt = (): void => {
            const sock = createConnection({ host, port });
            sock.once('connect', () => { sock.destroy(); resolve(); });
            sock.once('error', () => {
                sock.destroy();
                if (Date.now() - start > timeoutMs) {
                    reject(new Error(
                        `pgbouncer not reachable on localhost:${port} after ${timeoutMs / 1000}s.\n` +
                        `Ensure kubectl is authenticated and the cluster is reachable.`,
                    ));
                    return;
                }
                setTimeout(attempt, 500);
            });
        };
        attempt();
    });
}

// =============================================================================
// BUILD
// =============================================================================

function buildTypeScriptSafe(): void {
    const result = spawnSync(
        'node_modules/.bin/tsc',
        ['-b', 'applications/shared', 'applications/job-strategist', '--force'],
        { cwd: REPO_ROOT, encoding: 'utf8', stdio: 'inherit' },
    );

    const distEntry = path.join(
        REPO_ROOT,
        'applications/job-strategist/dist/run-pipeline.js',
    );

    if (result.status === 0) {
        ok('TypeScript compiled');
    } else if (existsSync(distEntry)) {
        warn('tsc exited non-zero (cross-package rootDir warnings are expected) — dist/run-pipeline.js present, continuing');
    } else {
        throw new Error('TypeScript build failed: dist/run-pipeline.js not emitted');
    }
}

// =============================================================================
// TEST RUNNER
// =============================================================================

function runJest(env: Record<string, string>): Promise<number> {
    const jest = spawn(
        'node_modules/.bin/jest',
        [
            '--config',          'applications/jest.config.js',
            '--testPathPattern', 'run-pipeline.integration',
            '--rootDir',         'applications/job-strategist',
            '--testTimeout',     '600000',
            '--runInBand',
            '--verbose',
            '--forceExit',
        ],
        {
            cwd:   REPO_ROOT,
            // Strip AWS_PROFILE so explicit ACCESS_KEY/SECRET vars take precedence.
            // AWS SDK v3 prefers AWS_PROFILE over static creds when both are set.
            env:   { ...process.env, AWS_PROFILE: undefined, ...env } as NodeJS.ProcessEnv,
            stdio: 'inherit',
        },
    );

    return new Promise<number>((resolve) => {
        jest.on('close', (code) => resolve(code ?? 1));
    });
}

// =============================================================================
// MAIN
// =============================================================================

async function main(): Promise<void> {
    const TOTAL_STEPS = SKIP_BUILD ? 4 : 5;
    let stepN = 0;
    const next = (msg: string): void => { stepN++; step(stepN, TOTAL_STEPS, msg); };

    console.log(`\n${BOLD}job-strategist integration test orchestrator${RESET}`);
    console.log(`${DIM}repo: ${REPO_ROOT}${RESET}`);

    // ── Step 1: resolve credentials ──────────────────────────────────────────
    next('Resolving RDS credentials');
    const creds = resolveCredentials();
    ok(`PG_USER=${creds.pgUser}  PG_DATABASE=${creds.pgDatabase}`);
    ok('PG_PASSWORD=*** (resolved)');

    // ── Step 2: start port-forward ───────────────────────────────────────────
    next(`Starting pgbouncer port-forward  localhost:${PF_PORT} → svc/pgbouncer:5432 (ns: ${PF_NS})`);
    const pf = startPortForward();

    // Kill port-forward on all exit paths
    const cleanup = (): void => {
        if (!pf.killed) {
            dim('Stopping port-forward...');
            pf.kill('SIGTERM');
        }
    };
    process.on('exit',    cleanup);
    process.on('SIGINT',  () => { cleanup(); process.exit(130); });
    process.on('SIGTERM', () => { cleanup(); process.exit(143); });

    dim('Waiting for pgbouncer to respond...');
    await waitForPort('127.0.0.1', PF_PORT);
    ok(`pgbouncer reachable at 127.0.0.1:${PF_PORT}`);

    // ── Step 3: build TypeScript (skippable) ─────────────────────────────────
    if (!SKIP_BUILD) {
        next('Building TypeScript  (shared + job-strategist)');
        buildTypeScriptSafe();
    }

    // ── Step 4: assemble test environment ────────────────────────────────────
    next('Assembling test environment');

    // Resolve AWS credentials explicitly so the pipeline subprocess (node dist/run-pipeline.js)
    // can reach Bedrock regardless of whether SSO tokens are cached or env vars are set.
    const awsCreds = resolveAwsCredentials();

    const testEnv: Record<string, string> = {
        PG_HOST:        '127.0.0.1',
        PG_PORT:        String(PF_PORT),
        PG_DATABASE:    creds.pgDatabase,
        PG_USER:        creds.pgUser,
        PG_PASSWORD:    creds.pgPassword,
        AWS_REGION,
        RESEARCH_MODEL,
        ENVIRONMENT:    'local',
        SKIP_CLEANUP,
        ...awsCreds,
    };
    if (process.env['TEST_USER_ID']) testEnv['TEST_USER_ID'] = process.env['TEST_USER_ID'];

    dim(`AWS_REGION=${AWS_REGION}`);
    dim(`RESEARCH_MODEL=${RESEARCH_MODEL}`);
    dim(`SKIP_CLEANUP=${SKIP_CLEANUP}`);
    ok('Test environment ready');

    // ── Step 5: run jest ─────────────────────────────────────────────────────
    next('Running jest integration suite');
    dim('(allow 2–5 min — Research Agent + Strategist Agent make real Bedrock calls)\n');

    const exitCode = await runJest(testEnv);

    // ── Summary ───────────────────────────────────────────────────────────────
    console.log('');
    if (exitCode === 0) {
        console.log(`${GREEN}${BOLD}✓ All integration tests passed.${RESET}`);
    } else {
        console.log(`${RED}${BOLD}✗ Integration tests failed (jest exit ${exitCode}).${RESET}`);
        console.log(
            `${DIM}Tip: rerun with SKIP_BUILD=1 to skip rebuild, ` +
            `SKIP_CLEANUP=1 to inspect rows in psql.${RESET}`,
        );
    }

    process.exit(exitCode);
}

main().catch((error_: unknown) => {
    fail(error_ instanceof Error ? error_.message : JSON.stringify(error_));
    process.exit(1);
});
