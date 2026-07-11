/**
 * @format
 * Research-agent (matcher) live eval — Haiku ↔ Sonnet A/B.
 *
 * GATED behind RUN_LIVE_EVALS=1 so default `jest`/CI never call Bedrock. This is
 * the spend step that validates the assessment-only refactor (increment 2) before
 * PR #232 merges, per CLAUDE.md #5.
 *
 * Run (once per model — RESEARCH_MODEL is read at module load):
 *   RUN_LIVE_EVALS=1 RESEARCH_MODEL=eu.anthropic.claude-haiku-4-5-20251001-v1:0 \
 *     USER_ID=<dev-user> JD_TEXT="<job description>" npx tsx \
 *     src/evals/research/run-research-eval.ts
 *   RUN_LIVE_EVALS=1 RESEARCH_MODEL=eu.anthropic.claude-sonnet-4-6 USER_ID=... JD_TEXT="..." npx tsx ...
 *
 * Then compare the two reports: coverage/schema/grounding/fitSanity must PASS for
 * both; verdictAccuracy + verdict stability are where Sonnet should win. Wiring
 * only — the graders + reconstruct helper hold the logic and are unit-tested.
 */
import { runResearchGraders, matchingToEvalOutput, type ResearchEvalCase } from './research-graders.js';

const LIVE_ENABLED = process.env['RUN_LIVE_EVALS'] === '1';

async function main(): Promise<void> {
    if (!LIVE_ENABLED) {
        console.log('RUN_LIVE_EVALS not set — skipping live research eval (no Bedrock spend).');
        return;
    }

    const jdText = process.env['JD_TEXT'];
    const userId = process.env['USER_ID'];
    if (!jdText || !userId) {
        console.error('Set JD_TEXT and USER_ID to run the live research eval.');
        process.exitCode = 1;
        return;
    }

    // Lazy imports: research-agent reads RESEARCH_MODEL at module load, so the env
    // must be set before this import — which it is by the time main() runs.
    const [{ extractJdSignal }, { executeResearchAgent }, { canonicalJdSkills }] = await Promise.all([
        import('../../agents/jd/jd-extractor.js'),
        import('../../agents/research/research-agent.js'),
        import('../../ats/canonical-jd-skills.js'),
    ]);

    const jdSignal = await extractJdSignal(jdText);
    const jdSkills = canonicalJdSkills(jdSignal);
    const evalCase: ResearchEvalCase = { name: 'live', jdSkills };

    const ctx = {
        pipelineId: 'eval-research',
        userId,
        operation: 'analyse' as const,
        applicationSlug: 'eval-research',
        targetRole: jdSignal.targetRole,
        targetCompany: 'eval',
        jobDescription: jdText,
        resumeId: '',
        resumeData: null,
        interviewStage: 'applied' as const,
        bucket: '',
        environment: 'eval',
        startedAt: new Date().toISOString(),
        cumulativeTokens: { input: 0, output: 0, thinking: 0 },
        cumulativeCostUsd: 0,
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeResearchAgent(ctx as any, undefined, '', '', jdSignal, null, '');
    const out = matchingToEvalOutput(result.data);
    const report = runResearchGraders(evalCase, out);

    console.log(`\nResearch eval — model=${process.env['RESEARCH_MODEL']} skills=${jdSkills.length}`);
    for (const r of report.results) {
        console.log(`  ${r.pass ? '✓' : '✗'} ${r.grader} (score ${r.score.toFixed(2)})${r.failures.length ? `\n     - ${r.failures.join('\n     - ')}` : ''}`);
    }
    console.log(`  overall: ${report.pass ? 'PASS' : 'FAIL'}\n`);
    process.exitCode = report.pass ? 0 : 1;
}

void main();
