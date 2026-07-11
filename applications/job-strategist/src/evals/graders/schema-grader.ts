/** @format */
import { CoachOutputSchema, PHONE_SCREEN_FIELDS } from '../../agents/coach/coach-agent.js';
import { mkResult } from '../graders.js';
import type { Grader } from '../graders.js';

/**
 * Asserts the output parses against the production CoachOutputSchema (reused, not
 * redefined — drift between the Zod schema and live output fails here; drift
 * between the Zod schema and COACH_TOOL.inputSchema is a separate concern not
 * covered by this grader) and that the phone-screen-only fields are present for
 * phone-screen and absent otherwise.
 */
export const schemaGrader: Grader = (input, output) => {
    const failures: string[] = [];

    // `stage`, `systemDesignCoverage`, and `barRaiserCoverage` are injected by run-coach
    // (not the model) and are not part of the strict CoachOutputSchema, so strip them before parsing.
    const rec = output as unknown as Record<string, unknown>;
    const { stage: _stage, systemDesignCoverage: _coverage, barRaiserCoverage: _brCoverage, ...rest } = rec;
    const parsed = CoachOutputSchema.safeParse(rest);
    if (!parsed.success) failures.push(`schema: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`);

    const isPhone = input.stage === 'phone-screen';
    for (const f of PHONE_SCREEN_FIELDS) {
        const present = rest[f] !== undefined;
        if (isPhone && !present) failures.push(`phone-screen missing required field: ${f}`);
        if (!isPhone && present) failures.push(`non-phone-screen must omit field: ${f}`);
    }

    return mkResult('schema', failures);
};
