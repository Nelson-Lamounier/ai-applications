/**
 * @format
 * Article-pipeline WRITER-phase eval runner (LOCAL / CI-live — not deployed).
 *
 * Generates REAL writer output (live Bedrock) for each golden brief, then grades
 * it with the deterministic article-quality checks (outline coverage, British
 * English, honest inline references, plausible reading time, valid slug). This
 * is the writer phase's eval per CLAUDE.md rule 5.
 *
 * Run:
 *   RUN_ARTICLE_WRITER_EVAL=1 \
 *   FOUNDATION_MODEL=eu.anthropic.claude-sonnet-4-6 \
 *   AWS_PROFILE=dev-account AWS_REGION=eu-west-1 \
 *   npx tsx applications/article-pipeline/src/evals/run-writer-eval.ts
 *
 * Env: RUN_ARTICLE_WRITER_EVAL=1 (gate), FOUNDATION_MODEL, AWS_PROFILE/REGION,
 *      WRITER_EVAL_MIN_PASS (default 1.0 — every brief must be fully clean).
 */
import type { PipelineContext } from '@bedrock/shared';

import { executeWriterAgent } from '../agents/writer-agent.js';
import { GOLDEN_BRIEFS } from './golden-briefs.js';
import { evaluateWriterOutput, formatWriterReports, type WriterCheckReport } from './article-quality-checks.js';

const MIN_PASS = Number.parseFloat(process.env['WRITER_EVAL_MIN_PASS'] ?? '1.0');

function evalContext(id: string): PipelineContext {
    return {
        pipelineId:        `writer-eval-${id}`,
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
    if (process.env['RUN_ARTICLE_WRITER_EVAL'] !== '1') {
        console.log('Writer eval is gated. Set RUN_ARTICLE_WRITER_EVAL=1 (+ FOUNDATION_MODEL, AWS_REGION) to run.');
        return;
    }

    const reports: WriterCheckReport[] = [];
    for (const brief of GOLDEN_BRIEFS) {
        const writer = await executeWriterAgent(evalContext(brief.id), brief.research);
        reports.push(evaluateWriterOutput(brief.id, writer.data, brief.research.outline));
        console.log(`  graded ${brief.id}`);
    }

    console.log('\n' + formatWriterReports(reports));

    const passRate = reports.filter((r) => r.ok).length / reports.length;
    const pass = passRate >= MIN_PASS;
    console.log(`\n==> gate: clean-brief rate ≥ ${(MIN_PASS * 100).toFixed(0)}% (got ${(passRate * 100).toFixed(0)}%) — ${pass ? 'PASS' : 'FAIL'}`);
    if (!pass) process.exit(2);
}

main()
    .then(() => process.exit(0))
    .catch((err) => { console.error('writer-eval failed:', err); process.exit(1); });
