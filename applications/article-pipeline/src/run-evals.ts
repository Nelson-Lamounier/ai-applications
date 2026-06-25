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
import { toEvalRunRows, persistEvalRuns } from './evals/persist-eval.js';

function required(name: string): string {
    const v = process.env[name];
    if (!v) throw new Error(`Missing required env var: ${name}`);
    return v;
}

interface EvalOutcome {
    readonly research: Awaited<ReturnType<typeof runResearchEval>>;
    readonly writer:   Awaited<ReturnType<typeof runWriterEval>>;
    readonly qa:       Awaited<ReturnType<typeof runQaEval>>;
    readonly researchPass: boolean;
    readonly writerPass:   boolean;
    readonly qaPass:       boolean;
    readonly overallPass:  boolean;
}

/** Run the three live phases in sequence and apply each phase's gate. */
async function runAllPhases(pool: ReturnType<typeof getPool>, userId: string): Promise<EvalOutcome> {
    log('INFO', 'eval: research phase', { userId });
    const research = await runResearchEval(pool, userId);
    const researchPass = researchEvalPasses(research);

    log('INFO', 'eval: writer phase', {});
    const writer = await runWriterEval();
    const writerPass = writerEvalPassRate(writer) >= WRITER_MIN_PASS;

    log('INFO', 'eval: qa phase', {});
    const qa = await runQaEval();
    const qaPass = qaEvalPasses(qa);

    return { research, writer, qa, researchPass, writerPass, qaPass, overallPass: researchPass && writerPass && qaPass };
}

/** Compact JSONB summary for the pipeline_runs row (UI poll). Pure. */
function buildSummary(o: EvalOutcome): Record<string, unknown> {
    return {
        eval: {
            overallPass: o.overallPass,
            research: {
                pass: o.researchPass,
                meanRecallPositive: o.research.meanRecallPositive,
                meanRecallNegative: o.research.meanRecallNegative,
                floor: RESEARCH_MIN_RECALL_POSITIVE,
                leakCeiling: RESEARCH_MAX_RECALL_NEGATIVE,
                perQuery: o.research.perQuery.map((q) => ({ id: q.id, kind: q.kind, repoRecall: q.repoRecall })),
            },
            writer: {
                pass: o.writerPass,
                passRate: writerEvalPassRate(o.writer),
                floor: WRITER_MIN_PASS,
                perBrief: o.writer.map((b) => ({ id: b.id, ok: b.ok, failed: b.checks.filter((c) => !c.passed).map((c) => c.name) })),
            },
            qa: {
                pass: o.qaPass,
                accuracy: o.qa.accuracy,
                floor: QA_MIN_ACCURACY,
                perCase: o.qa.perCase.map((c) => ({ id: c.id, expectedFlag: c.expectedFlag, detected: c.detected })),
            },
        },
    };
}

/** Chart the run in rag_eval_runs (Grafana). Best-effort — never changes outcome. */
async function chart(pool: ReturnType<typeof getPool>, o: EvalOutcome): Promise<void> {
    try {
        await persistEvalRuns(pool, toEvalRunRows(o.research, o.writer, o.qa, { research: o.researchPass, writer: o.writerPass, qa: o.qaPass }));
        log('INFO', 'eval: persisted to rag_eval_runs', {});
    } catch (e) {
        log('WARN', 'eval: rag_eval_runs persist failed — proceeding', { error: (e as Error).message });
    }
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
        const o = await runAllPhases(pool, userId);
        if (pipelineRunId) await updatePipelineRunMetadata(pool, pipelineRunId, buildSummary(o));
        await chart(pool, o);
        await setStatus(o.overallPass ? 'complete' : 'failed', o.overallPass ? undefined : 'one or more eval phases below gate');
        log('INFO', 'eval: done', { overallPass: o.overallPass, researchPass: o.researchPass, writerPass: o.writerPass, qaPass: o.qaPass });
        if (!o.overallPass) process.exitCode = 2;
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
