/** @format */
/**
 * One-time helper to capture a real coach run and seed a fixture's `output`.
 * Deferred per spec (v1 is fully offline). When needed:
 *   RUN_LIVE_EVALS=1 npx tsx src/evals/live/capture-fixture.ts <stage>
 * It should invoke coachAgent.execute with a chosen (analysis, candidateSets, stage),
 * then write { input, output } JSON to src/evals/fixtures/<stage>.json.
 */
export const CAPTURE_USAGE = 'RUN_LIVE_EVALS=1 npx tsx src/evals/live/capture-fixture.ts <stage>';
