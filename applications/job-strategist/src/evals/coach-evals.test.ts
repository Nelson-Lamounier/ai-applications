/** @format */
import phoneScreen from './fixtures/phone-screen.json';
import technical from './fixtures/technical.json';
import behavioural from './fixtures/behavioural.json';
import { runGraders } from './graders.js';
import type { EvalInput } from './graders.js';
import { schemaGrader } from './graders/schema-grader.js';
import { groundingGrader } from './graders/grounding-grader.js';
import { stageFocusGrader } from './graders/stage-focus-grader.js';
import { honestyGrader } from './graders/honesty-grader.js';
import type { InterviewCoachResult } from '@bedrock/shared';

const GRADERS = [schemaGrader, groundingGrader, stageFocusGrader, honestyGrader];
const FIXTURES = [
    { name: 'phone-screen', fx: phoneScreen },
    { name: 'technical', fx: technical },
    { name: 'behavioural', fx: behavioural },
];

describe('Tier 1 coach evals — gold fixtures pass all graders', () => {
    for (const { name, fx } of FIXTURES) {
        it(`${name} fixture passes every grader`, () => {
            const input = fx.input as unknown as EvalInput;
            const output = fx.output as unknown as InterviewCoachResult;
            const report = runGraders(GRADERS, input, output);
            const failures = report.results.flatMap(r => r.failures);
            expect(failures).toEqual([]);
            expect(report.pass).toBe(true);
        });
    }
});
