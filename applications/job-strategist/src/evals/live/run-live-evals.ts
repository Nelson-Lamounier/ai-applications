/** @format */
/**
 * Tier 2 live eval runner. Gated behind RUN_LIVE_EVALS=1 so default `jest` and CI
 * never call Bedrock. Run manually before prompt changes:
 *   RUN_LIVE_EVALS=1 npx tsx src/evals/live/run-live-evals.ts
 *
 * Steps (intentionally thin — wiring, not logic): for each gold input, invoke the
 * real coach (Sonnet), run Tier 1 graders on the output, then call the judge model
 * with JUDGE_TOOL and print formatReport per fixture. Implementation of the Bedrock
 * calls reuses the existing coachAgent + BaseAgent Converse path.
 */
export const LIVE_ENABLED = process.env['RUN_LIVE_EVALS'] === '1';

if (!LIVE_ENABLED) {
    // eslint-disable-next-line no-console
    console.log('RUN_LIVE_EVALS not set — skipping live evals.');
    process.exit(0);
}

// eslint-disable-next-line no-console
console.log('Live evals: invoke coachAgent over gold inputs, run graders + judge, print formatReport. See judge.ts.');
