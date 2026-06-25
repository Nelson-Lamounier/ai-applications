/**
 * @format
 * In-cluster article-pipeline EVAL entrypoint (dist/run-evals.js).
 *
 * Dispatched by admin-api as a one-shot K8s Job from the SAME article-pipeline
 * image, ServiceAccount and platform-rds-credentials secret as a real run — so
 * it has pgvector (PG_*) and Bedrock (IRSA) exactly as production does. It runs
 * all three per-phase evals against the live system and writes the result to its
 * own pipeline_runs row (status + metadata.eval), which the admin-api UI polls.
 *
 * This is the live (real-agent) counterpart to the deterministic eval scorers
 * that already gate every PR in jest. It is NEVER run in GitHub CI — it needs
 * the cluster's RDS + Bedrock, and it must run where article generation runs.
 *
 * Required env: USER_ID, PG_HOST, PG_DATABASE, PG_USER, PG_PASSWORD,
 *               FOUNDATION_MODEL, QA_MODEL, AWS_REGION.
 * Optional:     PIPELINE_RUN_ID (status row), PG_PORT (5432).
 */
import { log } from '@bedrock/shared';

import { getPool, closePool } from './lib/pg.js';
import { updatePipelineRun, updatePipelineRunMetadata } from './lib/pipeline-runs.js';
import {
    runResearchEval, researchEvalPasses,
    RESEARCH_MIN_RECALL_POSITIVE, RESEARCH_MAX_RECALL_NEGATIVE,
} from './evals/run-article-eval.js';
import { runWriterEval, writerEvalPassRate, WRITER_MIN_PASS } from './evals/run-writer-eval.js';
import { runQaEval, qaEvalPasses, QA_MIN_ACCURACY } from './evals/run-qa-eval.js';

function required(name: string): string {
    const v = process.env[name];
    if (!v) throw new Error(`Missing required env var: ${name}`);
    return v;
}

async function main(): Promise<void> {
    const userId        = required('USER_ID');
    const pipelineRunId = process.env['PIPELINE_RUN_ID'];
    const pool = getPool({
        host:     required('PG_HOST'),
        port:     Number.parseInt(process.env['PG_PORT'] ?? '5432', 10),
        database: required('PG_DATABASE'),
        user:     required('PG_USER'),
        password: required('PG_PASSWORD'),
    });

    const setStatus = async (status: string, errorMessage?: string): Promise<void> => {
        if (pipelineRunId) await updatePipelineRun(pool, pipelineRunId, status, errorMessage).catch(() => { /* best-effort */ });
    };

    try {
        await setStatus('running');

        // Research — pgvector retrieval grounding (needs the user's KB).
        log('INFO', 'eval: research phase', { userId });
        const research = await runResearchEval(pool, userId);
        const researchPass = researchEvalPasses(research);

        // Writer — live generation graded by deterministic quality checks.
        log('INFO', 'eval: writer phase', {});
        const writer = await runWriterEval();
        const writerRate = writerEvalPassRate(writer);
        const writerPass = writerRate >= WRITER_MIN_PASS;

        // QA — judge-the-judge over planted-defect cases.
        log('INFO', 'eval: qa phase', {});
        const qa = await runQaEval();
        const qaPass = qaEvalPasses(qa);

        const overallPass = researchPass && writerPass && qaPass;

        const summary = {
            eval: {
                overallPass,
                research: {
                    pass: researchPass,
                    meanRecallPositive: research.meanRecallPositive,
                    meanRecallNegative: research.meanRecallNegative,
                    floor: RESEARCH_MIN_RECALL_POSITIVE,
                    leakCeiling: RESEARCH_MAX_RECALL_NEGATIVE,
                    perQuery: research.perQuery.map((q) => ({ id: q.id, kind: q.kind, repoRecall: q.repoRecall })),
                },
                writer: {
                    pass: writerPass,
                    passRate: writerRate,
                    floor: WRITER_MIN_PASS,
                    perBrief: writer.map((b) => ({ id: b.id, ok: b.ok, failed: b.checks.filter((c) => !c.passed).map((c) => c.name) })),
                },
                qa: {
                    pass: qaPass,
                    accuracy: qa.accuracy,
                    floor: QA_MIN_ACCURACY,
                    perCase: qa.perCase.map((c) => ({ id: c.id, expectedFlag: c.expectedFlag, detected: c.detected })),
                },
            },
        };

        if (pipelineRunId) await updatePipelineRunMetadata(pool, pipelineRunId, summary);
        await setStatus(overallPass ? 'complete' : 'failed', overallPass ? undefined : 'one or more eval phases below gate');

        log('INFO', 'eval: done', { overallPass, researchPass, writerPass, qaPass });
        if (!overallPass) process.exitCode = 2;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await setStatus('failed', message);
        log('ERROR', 'eval: failed', { error: message });
        throw err;
    } finally {
        await closePool().catch(() => { /* best-effort */ });
    }
}

main().catch(() => process.exit(1));
