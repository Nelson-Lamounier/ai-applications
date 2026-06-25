/**
 * @format
 * Article-pipeline QA-phase eval runner (LOCAL / CI-live — not deployed).
 *
 * Feeds the REAL QA agent (live Bedrock) golden cases — one clean control and
 * one planted single-dimension defect each — and asserts it flags the right
 * dimension without crying wolf on the clean one. This is the QA phase's eval
 * per CLAUDE.md rule 5 ("correct phase focus").
 *
 * Run:
 *   RUN_ARTICLE_QA_EVAL=1 \
 *   QA_MODEL=eu.anthropic.claude-sonnet-4-6 \
 *   AWS_PROFILE=dev-account AWS_REGION=eu-west-1 \
 *   npx tsx applications/article-pipeline/src/evals/run-qa-eval.ts
 *
 * Env: RUN_ARTICLE_QA_EVAL=1 (gate), QA_MODEL, AWS_PROFILE/REGION,
 *      QA_EVAL_MIN_ACCURACY (default 0.75), QA_EVAL_DIM_THRESHOLD (default 70).
 */
import type { PipelineContext } from '@bedrock/shared';

import { executeQaAgent } from '../agents/qa-agent.js';
import { GOLDEN_QA_CASES } from './golden-qa-cases.js';
import { scoreQaCase, aggregate, passesGate, formatReport, type QaCaseResult } from './qa-eval-score.js';

const MIN_ACCURACY  = Number.parseFloat(process.env['QA_EVAL_MIN_ACCURACY'] ?? '0.75');
const DIM_THRESHOLD = Number.parseInt(process.env['QA_EVAL_DIM_THRESHOLD'] ?? '70', 10);

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

async function main(): Promise<void> {
    if (process.env['RUN_ARTICLE_QA_EVAL'] !== '1') {
        console.log('QA eval is gated. Set RUN_ARTICLE_QA_EVAL=1 (+ QA_MODEL, AWS_REGION) to run.');
        return;
    }

    const results: QaCaseResult[] = [];
    for (const c of GOLDEN_QA_CASES) {
        const qa = await executeQaAgent(evalContext(c.id), c.writer, c.technicalFacts, 'kb-augmented');
        const scored = scoreQaCase(c, qa.data, DIM_THRESHOLD);
        results.push(scored);
        console.log(`  ${c.id}: expected=${c.expectedFlag} → ${scored.detected ? 'correct' : 'MISS'} (rec=${scored.recommendation})`);
    }

    const report = aggregate(results);
    console.log('\n' + formatReport(report));

    const pass = passesGate(report, MIN_ACCURACY);
    console.log(`\n==> gate: accuracy ≥ ${(MIN_ACCURACY * 100).toFixed(0)}% (got ${(report.accuracy * 100).toFixed(0)}%) — ${pass ? 'PASS' : 'FAIL'}`);
    if (!pass) process.exit(2);
}

main()
    .then(() => process.exit(0))
    .catch((err) => { console.error('qa-eval failed:', err); process.exit(1); });
