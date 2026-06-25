/**
 * @format
 * Article-pipeline QA-phase eval.
 *
 * Feeds the REAL QA agent (live Bedrock) golden cases — one clean control and
 * one planted single-dimension defect each — and asserts it flags the right
 * dimension without crying wolf on the clean one.
 *
 * The scoring core is exported as {@link runQaEval} for the in-cluster
 * orchestrator (run-evals.ts). The gated `main()` is the LOCAL ad-hoc path.
 *
 * Local run:
 *   RUN_ARTICLE_QA_EVAL=1 QA_MODEL=eu.anthropic.claude-sonnet-4-6 \
 *   AWS_PROFILE=dev-account AWS_REGION=eu-west-1 \
 *   npx tsx applications/article-pipeline/src/evals/run-qa-eval.ts
 */
import type { PipelineContext } from '@bedrock/shared';

import { executeQaAgent } from '../agents/qa-agent.js';
import { GOLDEN_QA_CASES } from './golden-qa-cases.js';
import { scoreQaCase, aggregate, passesGate, formatReport, type QaCaseResult, type QaEvalReport } from './qa-eval-score.js';

export const QA_MIN_ACCURACY  = Number.parseFloat(process.env['QA_EVAL_MIN_ACCURACY'] ?? '0.75');
export const QA_DIM_THRESHOLD = Number.parseInt(process.env['QA_EVAL_DIM_THRESHOLD'] ?? '70', 10);

function evalContext(id: string): PipelineContext {
    return {
        pipelineId:        `qa-eval-${id}`,
        userId:            'eval',
        slug:              id,
        sourceKey:         `drafts/${id}.md`,
        bucket:            'eval',
        environment:       'eval',
        version:           1,
        cumulativeTokens:  { input: 0, output: 0, thinking: 0 },
        cumulativeCostUsd: 0,
        retryAttempt:      0,
        startedAt:         new Date().toISOString(),
    };
}

/** Run every golden QA case through the real QA agent. Pure of process exit. */
export async function runQaEval(dimThreshold = QA_DIM_THRESHOLD): Promise<QaEvalReport> {
    const results: QaCaseResult[] = [];
    for (const c of GOLDEN_QA_CASES) {
        const qa = await executeQaAgent(evalContext(c.id), c.writer, c.technicalFacts, 'kb-augmented');
        results.push(scoreQaCase(c, qa.data, dimThreshold));
    }
    return aggregate(results);
}

export function qaEvalPasses(report: QaEvalReport): boolean {
    return passesGate(report, QA_MIN_ACCURACY);
}

async function main(): Promise<void> {
    if (process.env['RUN_ARTICLE_QA_EVAL'] !== '1') {
        console.log('QA eval is gated. Set RUN_ARTICLE_QA_EVAL=1 (+ QA_MODEL, AWS_REGION) to run, or dispatch the in-cluster eval Job.');
        return;
    }
    const report = await runQaEval();
    console.log('\n' + formatReport(report));
    const pass = qaEvalPasses(report);
    console.log(`\n==> gate: accuracy ≥ ${(QA_MIN_ACCURACY * 100).toFixed(0)}% (got ${(report.accuracy * 100).toFixed(0)}%) — ${pass ? 'PASS' : 'FAIL'}`);
    if (!pass) process.exit(2);
}

if (require.main === module) {
    main()
        .then(() => process.exit(0))
        .catch((err) => { console.error('qa-eval failed:', err); process.exit(1); });
}
