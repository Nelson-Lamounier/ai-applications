/**
 * @format
 * Integration test — full job-strategist analysis pipeline.
 *
 * Spawns `node dist/run-pipeline.js` exactly as a K8s Job would, against a
 * real RDS instance and real Bedrock endpoints. No mocks.
 *
 * Prerequisites
 * ─────────────
 *   1. Port-forward pgbouncer:
 *        kubectl port-forward svc/pgbouncer 15432:5432 -n platform
 *
 *   2. AWS credentials with bedrock:InvokeModel permission in env
 *        (default credential chain — profile, instance role, env vars)
 *
 *   3. Compiled dist/ — from repo root:
 *        node_modules/.bin/tsc -b applications/shared applications/job-strategist --force || true
 *
 * Run
 * ───
 *   PG_PASSWORD="<secret>" \
 *   AWS_REGION=eu-west-1 \
 *   npx jest --config applications/jest.config.js \
 *     --testPathPattern="run-pipeline.integration" \
 *     --rootDir applications/job-strategist \
 *     --testTimeout=600000 \
 *     --runInBand
 *
 * Override defaults
 * ─────────────────
 *   PG_HOST          default 127.0.0.1
 *   PG_PORT          default 15432  (port-forward)
 *   PG_DATABASE      default tucaken
 *   PG_USER          default postgres
 *   TEST_USER_ID     default 31f4686a-...  (user with document_embeddings)
 *   RESEARCH_MODEL   default eu.anthropic.claude-haiku-4-5-20251001-v1:0
 *   SKIP_CLEANUP     set to '1' to preserve test rows for inspection
 */

import { randomUUID }    from 'node:crypto';
import { spawn }         from 'node:child_process';
import path              from 'node:path';
import { Pool }          from 'pg';

// =============================================================================
// GROUNDING UNIT TEST MOCKS
// jest.mock calls are hoisted by Jest — they do not affect the subprocess-based
// integration suites below (those spawn a real child process).
// =============================================================================

const groundingVerifyMock = jest.fn();

jest.mock('@bedrock/shared', () => {
    const actual = jest.requireActual<typeof import('@bedrock/shared')>('@bedrock/shared');
    return {
        ...actual,
        BedrockGroundingVerifier: jest.fn().mockImplementation(() => ({
            verify: groundingVerifyMock,
        })),
        bootstrapK8sObservability: jest.fn().mockReturnValue({
            logger: {
                info: jest.fn(),
                warn: jest.fn(),
                error: jest.fn(),
            },
            registry: {},
            shutdown: jest.fn().mockResolvedValue(undefined),
        }),
        pushFinalMetrics: jest.fn().mockResolvedValue(undefined),
    };
});

jest.mock('../agents/research-agent', () => ({
    executeResearchAgent: jest.fn(),
}));

jest.mock('../agents/strategist-agent', () => ({
    executeStrategistAgent: jest.fn(),
}));

jest.mock('../env', () => ({
    parseEnv: jest.fn(),
}));

jest.mock('../lib/pg', () => ({
    getPool: jest.fn(),
    closePool: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../lib/pipeline-runs', () => ({
    updatePipelineRun:          jest.fn().mockResolvedValue(undefined),
    updatePipelineRunMetadata:  jest.fn().mockResolvedValue(undefined),
    updateJobApplicationStatus: jest.fn().mockResolvedValue(undefined),
    persistTailoredResume:      jest.fn().mockResolvedValue({ resumeId: 'resume-test-id' }),
}));

jest.mock('prom-client', () => ({
    Counter:   jest.fn().mockImplementation(() => ({ inc: jest.fn() })),
    Histogram: jest.fn().mockImplementation(() => ({ observe: jest.fn() })),
    Registry:  jest.fn(),
}));

// =============================================================================
// CONFIG
// =============================================================================

const PG_CONFIG = {
    host:     process.env['PG_HOST']     ?? '127.0.0.1',
    port:     Number(process.env['PG_PORT']     ?? '15432'),
    database: process.env['PG_DATABASE'] ?? 'tucaken',
    user:     process.env['PG_USER']     ?? 'postgres',
    password: process.env['PG_PASSWORD'] ?? '',
};

/** User that has document_embeddings rows — required for non-empty KB retrieval. */
const TEST_USER_ID   = process.env['TEST_USER_ID']   ?? '31f4686a-979b-4765-a17c-22a1e71cec59';
const AWS_REGION     = process.env['AWS_REGION']     ?? 'eu-west-1';
const RESEARCH_MODEL = process.env['RESEARCH_MODEL'] ?? 'eu.anthropic.claude-haiku-4-5-20251001-v1:0';
const SKIP_CLEANUP   = process.env['SKIP_CLEANUP']   === '1';

const DIST_DIR = path.resolve(__dirname, '../../dist');

const JOB_DESCRIPTION = `
We are hiring a Senior Platform Engineer to own the design, implementation, and reliability
of our Kubernetes-based deployment platform across multiple AWS regions at Revolut.

Responsibilities:
  - Maintain and scale EKS clusters using Helm, ArgoCD (GitOps), and Terraform / CDK.
  - Own observability: Prometheus, Grafana dashboards, Loki log aggregation, Tempo tracing.
  - Drive DORA metric improvements: lead time, MTTR, change failure rate, deployment frequency.
  - Design and operate RDS Aurora PostgreSQL clusters, including pgvector extensions.
  - Collaborate with product engineering to reduce deployment friction and improve SLA to 99.99%.
  - Implement cost attribution and FinOps tooling for cloud spend visibility.

Requirements:
  - 5+ years of platform / DevOps / SRE experience.
  - Deep Kubernetes expertise (EKS preferred). CKA a strong plus.
  - Production experience with Terraform or CDK for AWS IaC.
  - Strong scripting skills — TypeScript or Python.
  - Experience with Prometheus/Grafana alerting and incident response.
  - Familiarity with zero-downtime deployment strategies (blue/green, canary).
  - Excellent communication and documentation habits.
`.trim();

// =============================================================================
// HELPERS
// =============================================================================

let pool: Pool;

async function db<T extends object = Record<string, unknown>>(
    sql:    string,
    params: unknown[] = [],
): Promise<T[]> {
    const res = await pool.query<T>(sql, params);
    return res.rows;
}

interface PipelineResult {
    code:   number;
    stdout: string;
    stderr: string;
}

function runPipeline(env: Record<string, string>): Promise<PipelineResult> {
    return new Promise((resolve) => {
        const proc = spawn('node', ['dist/run-pipeline.js'], {
            cwd: path.resolve(DIST_DIR, '..'),
            env: { ...process.env, ...env },
        });

        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (chunk: Buffer) => {
            const text = chunk.toString();
            stdout += text;
            process.stdout.write(`  [pipeline] ${text}`);
        });
        proc.stderr.on('data', (chunk: Buffer) => {
            const text = chunk.toString();
            stderr += text;
            process.stderr.write(`  [pipeline:err] ${text}`);
        });

        proc.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    });
}

// =============================================================================
// SUITE
// =============================================================================

describe('job-strategist run-pipeline.js — integration', () => {
    jest.setTimeout(600_000);   // 10 min — Bedrock latency can be high

    const pipelineRunId = randomUUID();
    const applicationId = randomUUID();

    let pipelineResult: PipelineResult;

    // ── Pre-flight ─────────────────────────────────────────────────────────

    beforeAll(async () => {
        pool = new Pool({ ...PG_CONFIG, max: 2, ssl: false });
        try {
            await pool.query('SELECT 1');
        } catch (err) {
            throw new Error(
                `Cannot reach RDS — is kubectl port-forward running?\n` +
                `  kubectl port-forward svc/pgbouncer 15432:5432 -n platform\n` +
                `Underlying error: ${(err as Error).message}`,
            );
        }

        // Verify document_embeddings exist for the test user
        const [{ count }] = await db<{ count: string }>(
            `SELECT count(*)::text FROM document_embeddings WHERE user_id = $1`,
            [TEST_USER_ID],
        );
        if (Number(count) === 0) {
            throw new Error(
                `TEST_USER_ID ${TEST_USER_ID} has no rows in document_embeddings.\n` +
                `The pipeline will run in zero-evidence mode. ` +
                `Run the ingestion pipeline for this user first or set TEST_USER_ID to a user with data.`,
            );
        }

        // Insert job_applications row (normally created by admin-api strategist-job route)
        await pool.query(`
            INSERT INTO job_applications (id, user_id, company, role, job_description, kanban_status)
            VALUES ($1, $2, 'Revolut', 'Senior Platform Engineer', $3, 'analysing')
        `, [applicationId, TEST_USER_ID, JOB_DESCRIPTION]);

        // Insert pipeline_runs row (normally created by admin-api insertPipelineRun)
        await pool.query(`
            INSERT INTO pipeline_runs (id, user_id, pipeline_type, reference_id, status, metadata)
            VALUES ($1, $2, 'strategist', $3, 'queued', $4::jsonb)
        `, [
            pipelineRunId,
            TEST_USER_ID,
            applicationId,
            JSON.stringify({ targetCompany: 'Revolut', targetRole: 'Senior Platform Engineer', mode: 'standard' }),
        ]);

        // Run the pipeline — this is the expensive step (~2–5 min)
        pipelineResult = await runPipeline({
            PIPELINE_RUN_ID:  pipelineRunId,
            APPLICATION_ID:   applicationId,
            APPLICATION_SLUG: applicationId,
            USER_ID:          TEST_USER_ID,
            TARGET_COMPANY:   'Revolut',
            TARGET_ROLE:      'Senior Platform Engineer',
            JOB_DESCRIPTION:  JOB_DESCRIPTION,
            MODE:             'standard',
            RESEARCH_MODEL,
            AWS_REGION,
            PG_HOST:          PG_CONFIG.host,
            PG_PORT:          String(PG_CONFIG.port),
            PG_DATABASE:      PG_CONFIG.database,
            PG_USER:          PG_CONFIG.user,
            PG_PASSWORD:      PG_CONFIG.password,
            RDS_HOST:         PG_CONFIG.host,
            RDS_PORT:         String(PG_CONFIG.port),
            RDS_DB_NAME:      PG_CONFIG.database,
            RDS_USER:         PG_CONFIG.user,
            RDS_PASSWORD:     PG_CONFIG.password,
            ENVIRONMENT:      'local',
            // Disable OTel and Pushgateway — both are no-ops when these are absent
            // (bootstrapK8sObservability skips SDK init; pushFinalMetrics catches errors)
        });
    }, 600_000);    // 10 min — pipeline makes real Bedrock calls

    afterAll(async () => {
        if (SKIP_CLEANUP) {
            console.log(`\n[SKIP_CLEANUP=1] Rows preserved:\n  pipelineRunId=${pipelineRunId}\n  applicationId=${applicationId}`);
        } else {
            await pool.query('DELETE FROM resumes          WHERE job_application_id = $1', [applicationId]);
            await pool.query('DELETE FROM coaching_content WHERE job_application_id = $1', [applicationId]);
            await pool.query('DELETE FROM pipeline_runs    WHERE id = $1', [pipelineRunId]);
            await pool.query('DELETE FROM job_applications WHERE id = $1', [applicationId]);
        }
        await pool.end();
    });

    // ── Process exit ───────────────────────────────────────────────────────

    it('process exits with code 0', () => {
        if (pipelineResult.code !== 0) {
            // Emit the last 50 lines of stderr to help diagnose failures
            const tail = pipelineResult.stderr.split('\n').slice(-50).join('\n');
            throw new Error(`Pipeline exited with code ${pipelineResult.code}.\nLast stderr:\n${tail}`);
        }
        expect(pipelineResult.code).toBe(0);
    });

    // ── RDS state ──────────────────────────────────────────────────────────

    it('pipeline_runs row reaches status=complete', async () => {
        const [row] = await db<{ status: string; error_message: string | null }>(
            `SELECT status, error_message FROM pipeline_runs WHERE id = $1`,
            [pipelineRunId],
        );
        expect(row).toBeDefined();
        expect(row.status).toBe('complete');
        expect(row.error_message).toBeNull();
    });

    it('job_applications kanban_status is analysis-ready', async () => {
        const [row] = await db<{ kanban_status: string }>(
            `SELECT kanban_status FROM job_applications WHERE id = $1`,
            [applicationId],
        );
        expect(row).toBeDefined();
        expect(row.kanban_status).toBe('analysis-ready');
    });

    // ── Resume persistence ─────────────────────────────────────────────────

    it('persists exactly one resume to the resumes table', async () => {
        const rows = await db<{ id: string; label: string }>(
            `SELECT id, label FROM resumes WHERE job_application_id = $1`,
            [applicationId],
        );
        expect(rows).toHaveLength(1);
        expect(rows[0].label).toMatch(/Tailored/i);
    });

    it('resume content_json passes StructuredResumeData schema checks', async () => {
        const [row] = await db<{ content_json: Record<string, unknown> }>(
            `SELECT content_json FROM resumes WHERE job_application_id = $1`,
            [applicationId],
        );
        expect(row).toBeDefined();
        const r = row.content_json;

        // Top-level fields
        expect(r).toHaveProperty('profile');
        expect(r).toHaveProperty('summary');
        expect(r).toHaveProperty('experience');
        expect(r).toHaveProperty('skills');
        expect(r).toHaveProperty('education');

        // Profile sub-object
        const profile = r['profile'] as Record<string, unknown>;
        expect(typeof profile['name']).toBe('string');
        expect((profile['name'] as string).length).toBeGreaterThan(0);

        // Arrays are populated
        expect(Array.isArray(r['experience'])).toBe(true);
        expect((r['experience'] as unknown[]).length).toBeGreaterThan(0);

        expect(Array.isArray(r['skills'])).toBe(true);
        expect((r['skills'] as unknown[]).length).toBeGreaterThan(0);
    });

    // ── Analysis metadata ──────────────────────────────────────────────────

    it('pipeline_runs metadata contains analysis XML', async () => {
        const [row] = await db<{ metadata: Record<string, unknown> }>(
            `SELECT metadata FROM pipeline_runs WHERE id = $1`,
            [pipelineRunId],
        );
        expect(row).toBeDefined();
        const meta = row.metadata;
        expect(meta).toBeDefined();

        // The analysis object is stored as { analysis: StrategistAnalysisResult }
        expect(meta).toHaveProperty('analysis');
        const analysis = meta['analysis'] as Record<string, unknown>;
        expect(typeof analysis['analysisXml']).toBe('string');
        expect((analysis['analysisXml'] as string).length).toBeGreaterThan(200);
    });

    it('pipeline_runs metadata analysis has a cover letter', async () => {
        const [row] = await db<{ metadata: Record<string, unknown> }>(
            `SELECT metadata FROM pipeline_runs WHERE id = $1`,
            [pipelineRunId],
        );
        const analysis = (row.metadata['analysis'] as Record<string, unknown>);
        const coverLetter = analysis['coverLetter'];
        // Cover letter is generated by default (includeCoverLetter defaults to true)
        expect(typeof coverLetter).toBe('string');
        expect((coverLetter as string).length).toBeGreaterThan(100);
    });

    // ── KB retrieval quality ───────────────────────────────────────────────

    it('stdout shows non-empty KB retrieval (factualSizeKb > 0)', () => {
        // The research agent logs: "Retrieval complete" with factualSizeKb
        // This confirms RDS pgvector returned results for the test user.
        expect(pipelineResult.stdout).toMatch(/"factualSizeKb"/);
        // Check it's not 'empty'
        expect(pipelineResult.stdout).not.toMatch(/"factualSizeKb":"empty"/);
    });

    it('stdout records pipeline phases in order', () => {
        const stdout = pipelineResult.stdout;
        // Check actual logged messages (status DB updates are not logged to stdout)
        const retrievalIdx = stdout.indexOf('Retrieval complete');
        const agentIdx     = stdout.indexOf('Starting agent execution');
        const completeIdx  = stdout.indexOf('strategist_pipeline_complete');
        expect(retrievalIdx).toBeGreaterThan(-1);
        expect(agentIdx).toBeGreaterThan(retrievalIdx);
        expect(completeIdx).toBeGreaterThan(agentIdx);
    });
});

// =============================================================================
// FAILURE PATH SUITE
// =============================================================================

describe('job-strategist run-pipeline.js — failure path', () => {
    jest.setTimeout(120_000);

    let pool: Pool;

    beforeAll(async () => {
        pool = new Pool({ ...PG_CONFIG, max: 2, ssl: false });
        await pool.query('SELECT 1').catch(() => {
            throw new Error('Cannot reach RDS — is kubectl port-forward running?');
        });
    });

    afterAll(async () => { await pool.end(); });

    it('exits non-zero and records status=failed when RESEARCH_MODEL is missing', async () => {
        const pipelineRunId = randomUUID();
        const applicationId = randomUUID();

        await pool.query(`
            INSERT INTO job_applications (id, user_id, company, role, job_description, kanban_status)
            VALUES ($1, $2, 'TestCo', 'Engineer', 'JD text for failure test', 'analysing')
        `, [applicationId, TEST_USER_ID]);

        await pool.query(`
            INSERT INTO pipeline_runs (id, user_id, pipeline_type, reference_id, status, metadata)
            VALUES ($1, $2, 'strategist', $3, 'queued', '{}')
        `, [pipelineRunId, TEST_USER_ID, applicationId]);

        const result = await runPipeline({
            PIPELINE_RUN_ID:  pipelineRunId,
            APPLICATION_ID:   applicationId,
            APPLICATION_SLUG: applicationId,
            USER_ID:          TEST_USER_ID,
            TARGET_COMPANY:   'TestCo',
            TARGET_ROLE:      'Senior Engineer',
            JOB_DESCRIPTION:  'We are looking for a senior engineer to join our platform team and help build scalable infrastructure.',
            // Empty string is falsy — triggers the !RESEARCH_MODEL guard at module load.
            // Must be explicit: Jest inherits RESEARCH_MODEL from the orchestrator env,
            // so omitting the key leaves the inherited value in { ...process.env, ...env }.
            RESEARCH_MODEL:   '',
            AWS_REGION,
            PG_HOST:     PG_CONFIG.host,
            PG_PORT:     String(PG_CONFIG.port),
            PG_DATABASE: PG_CONFIG.database,
            PG_USER:     PG_CONFIG.user,
            PG_PASSWORD: PG_CONFIG.password,
            RDS_HOST:    PG_CONFIG.host,
            RDS_PORT:    String(PG_CONFIG.port),
            RDS_DB_NAME: PG_CONFIG.database,
            RDS_USER:    PG_CONFIG.user,
            RDS_PASSWORD: PG_CONFIG.password,
            ENVIRONMENT: 'local',
        });

        expect(result.code).toBeGreaterThan(0);

        // Cleanup
        await pool.query('DELETE FROM pipeline_runs    WHERE id = $1', [pipelineRunId]);
        await pool.query('DELETE FROM job_applications WHERE id = $1', [applicationId]);
    }, 120_000);
});

// =============================================================================
// GROUNDING UNIT TESTS
// These tests drive main() in-process with all external dependencies mocked.
// They verify the grounding block in run-pipeline.ts — not the subprocess path.
// =============================================================================

describe('job-strategist run-pipeline — grounding (block mode, in-process)', () => {
    jest.setTimeout(10_000);

    // Shared mock handles — resolved after jest.mock hoisting.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { executeResearchAgent }   = require('../agents/research-agent') as { executeResearchAgent: jest.Mock };
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { executeStrategistAgent } = require('../agents/strategist-agent') as { executeStrategistAgent: jest.Mock };
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { parseEnv }               = require('../env') as { parseEnv: jest.Mock };
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getPool }                = require('../lib/pg') as { getPool: jest.Mock };
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { updatePipelineRunMetadata } = require('../lib/pipeline-runs') as { updatePipelineRunMetadata: jest.Mock };

    /** Minimal env returned by mocked parseEnv */
    const FAKE_ENV = {
        pipelineId:    'pipe-test',
        pipelineRunId: 'run-test',
        applicationId: 'app-test',
        applicationSlug: 'app-test',
        userId:        'user-test',
        targetRole:    'Senior Engineer',
        targetCompany: 'TestCo',
        jobDescription: 'Build scalable systems.',
        resumeId:      null,
        environment:   'test' as const,
        pg: { host: 'localhost', port: 5432, database: 'test', user: 'test', password: 'test' },
    };

    /** Minimal research result with a deduped kbContext */
    const FAKE_RESEARCH_DATA = {
        kbContext:           'chunk one\n\n---\n\nchunk two',
        targetRole:          'Senior Engineer',
        targetCompany:       'TestCo',
        seniority:           'senior',
        domain:              'platform',
        overallFitRating:    'STRONG' as const,
        fitSummary:          'Great fit.',
        hardRequirements:    [],
        softRequirements:    [],
        implicitRequirements:[],
        verifiedMatches:     [],
        partialMatches:      [],
        gaps:                [],
        technologyInventory: { languages:[], frameworks:[], infrastructure:[], tools:[], methodologies:[] },
        experienceSignals:   { yearsExpected:'5+', domainExperience:'platform', leadershipExpectation:'none', scaleIndicators:'medium' },
        resumeData:          null,
        resumeConstraints:   '',
    };

    /** Minimal analysis result */
    const FAKE_ANALYSIS_DATA = {
        analysisXml:        '<analysis>ORIGINAL_XML</analysis>',
        metadata:           { candidateName:'A', targetRole:'Senior Engineer', targetCompany:'TestCo', analysisDate:'2026-01-01', overallFitRating:'STRONG' as const, applicationRecommendation:'APPLY' as const },
        coverLetter:        null,
        archetypeSelection: null,
        tailoredResumeData: null,
        resumeSuggestions:  { additions:[], reframes:[], eslCorrections:[] },
        resumeAdditions:    0,
        resumeReframes:     0,
        eslCorrections:     0,
    };

    /** Fake pool — all queries are no-ops */
    const fakePool = {
        query: jest.fn().mockResolvedValue({ rows: [] }),
    };

    beforeEach(() => {
        jest.clearAllMocks();

        parseEnv.mockReturnValue(FAKE_ENV);
        getPool.mockReturnValue(fakePool);

        executeResearchAgent.mockResolvedValue({ data: FAKE_RESEARCH_DATA });
        executeStrategistAgent.mockResolvedValue({ data: FAKE_ANALYSIS_DATA });

        // Default grounding: GROUNDED — returns original answer unchanged.
        groundingVerifyMock.mockResolvedValue({
            status: 'GROUNDED',
            reason: 'all claims supported',
            ungroundedClaims: [],
            answer: FAKE_ANALYSIS_DATA.analysisXml,
        });
    });

    it('substitutes fallback when strategist output is NOT_GROUNDED (block)', async () => {
        groundingVerifyMock.mockResolvedValueOnce({
            status: 'NOT_GROUNDED',
            reason: 'r',
            ungroundedClaims: [],
            answer: 'GROUNDING_FALLBACK_XYZ',
        });

        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { main } = require('../run-pipeline') as { main: () => Promise<void> };
        await main();

        // The persisted metadata must contain the fallback string in analysisXml.
        expect(updatePipelineRunMetadata).toHaveBeenCalledTimes(1);
        const [, , metadata] = updatePipelineRunMetadata.mock.calls[0] as [unknown, unknown, { analysis: { analysisXml: string } }];
        expect(metadata.analysis.analysisXml).toContain('GROUNDING_FALLBACK_XYZ');
    });

    it('does not hard-fail when the grounding verifier throws (fail-open)', async () => {
        groundingVerifyMock.mockRejectedValueOnce(new Error('bedrock down'));

        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { main } = require('../run-pipeline') as { main: () => Promise<void> };
        await expect(main()).resolves.toBeUndefined();

        // Pipeline must still persist — with the original analysisXml.
        expect(updatePipelineRunMetadata).toHaveBeenCalledTimes(1);
        const [, , metadata] = updatePipelineRunMetadata.mock.calls[0] as [unknown, unknown, { analysis: { analysisXml: string } }];
        expect(metadata.analysis.analysisXml).toBe(FAKE_ANALYSIS_DATA.analysisXml);
    });

    it('skips grounding and preserves original analysis when KB context is empty', async () => {
        // Override research data so kbContext is empty — simulates sparse-portfolio user.
        const emptyKbResearch = { ...FAKE_RESEARCH_DATA, kbContext: '' };
        executeResearchAgent.mockResolvedValueOnce({ data: emptyKbResearch });

        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { main } = require('../run-pipeline') as { main: () => Promise<void> };
        await main();

        // Verifier must NOT have been called when there are no context chunks.
        expect(groundingVerifyMock).not.toHaveBeenCalled();

        // Persisted metadata must contain the original analysisXml — NOT a fallback.
        expect(updatePipelineRunMetadata).toHaveBeenCalledTimes(1);
        const [, , metadata] = updatePipelineRunMetadata.mock.calls[0] as [unknown, unknown, { analysis: { analysisXml: string } }];
        expect(metadata.analysis.analysisXml).toBe(FAKE_ANALYSIS_DATA.analysisXml);
    });
});
