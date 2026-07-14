/**
 * @format
 * Summary-agent (B1) live eval — gated smoke test of executeSummaryAgent
 * against real Bedrock output.
 *
 * GATED behind RUN_LIVE_EVALS=1 so default `jest`/CI never call Bedrock
 * (CLAUDE.md #5). Self-contained by design: unlike run-research-eval.ts,
 * this runner needs only Bedrock credentials, not the private dev RDS — the
 * `research`/`body` context is built from the B2a fixtures (GOLDEN_SUMMARY,
 * ADVERSARIAL_FIT), not a live user record.
 *
 * Run:
 *   RUN_LIVE_EVALS=1 npx tsx src/evals/summary/run-summary-eval.ts
 *
 * Both fixtures are run: GOLDEN_SUMMARY (clean fit) and ADVERSARIAL_FIT (a
 * fitSummary that names a real shortfall) — the latter checks whether the
 * live model echoes the gap into the emitted resume summary, which the
 * `noGap` grader would catch.
 */
import type { StrategistResearchResult } from '@bedrock/shared';
import { runSummaryGraders, type SummaryEvalInput } from './summary-graders.js';
import { GOLDEN_SUMMARY, ADVERSARIAL_FIT } from './fixtures.js';

const LIVE_ENABLED = process.env['RUN_LIVE_EVALS'] === '1';

/** Named fixtures to run against the live agent, in display order. */
const FIXTURES: ReadonlyArray<{ name: string; fixture: SummaryEvalInput }> = [
    { name: 'golden', fixture: GOLDEN_SUMMARY },
    { name: 'adversarial-fit', fixture: ADVERSARIAL_FIT },
];

async function main(): Promise<void> {
    if (!LIVE_ENABLED) {
        console.log('RUN_LIVE_EVALS not set — skipping live summary eval (no Bedrock spend).');
        return;
    }

    const { executeSummaryAgent } = await import('../../agents/writer/summary-agent.js');

    const ctx = {
        pipelineId: 'eval-summary',
        userId: 'eval',
        operation: 'analyse' as const,
        applicationSlug: 'eval-summary',
        targetRole: 'Software Engineer',
        targetCompany: 'eval',
        jobDescription: '',
        resumeId: '',
        resumeData: null,
        interviewStage: 'applied' as const,
        bucket: '',
        environment: 'eval',
        startedAt: new Date().toISOString(),
        cumulativeTokens: { input: 0, output: 0, thinking: 0 },
        cumulativeCostUsd: 0,
    };

    let allPass = true;

    for (const { name, fixture } of FIXTURES) {
        const research = {
            fitSummary: fixture.fitSummary,
            overallFitRating: 'REASONABLE FIT',
            verifiedMatches: [],
            partialMatches: [],
            gaps: fixture.gapSkills.map((skill) => ({ skill })),
            companyProblem: '',
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any as StrategistResearchResult;

        const input = {
            research,
            body: fixture.body,
            profileIntelligence: '',
            yearsGapFraming: '',
            achievementEvidence: '',
        };

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await executeSummaryAgent(ctx as any, input);

        const evalInput: SummaryEvalInput = {
            summary: result.data.summary,
            body: fixture.body,
            fitSummary: fixture.fitSummary,
            gapSkills: fixture.gapSkills,
            targetCompany: fixture.targetCompany,
        };
        const report = runSummaryGraders(evalInput);
        allPass = allPass && report.pass;

        console.log(`\nSummary eval — fixture=${name}`);
        console.log(`  summary: "${result.data.summary}"`);
        for (const r of report.results) {
            console.log(`  ${r.pass ? '✓' : '✗'} ${r.grader} (score ${r.score.toFixed(2)})${r.failures.length ? `\n     - ${r.failures.join('\n     - ')}` : ''}`);
        }
        console.log(`  overall: ${report.pass ? 'PASS' : 'FAIL'}`);
    }

    console.log(`\nSummary live eval — ${allPass ? 'PASS' : 'FAIL'}\n`);
    process.exitCode = allPass ? 0 : 1;
}

void main();
