/**
 * @format
 * Final-round prep hygiene — drops empty/whitespace talking points and
 * questions, passes through undefined, keeps real entries and prose fields.
 */
import { validateFinalPrep } from '../final-validation.js';

it('drops empty talking points + keeps real ones', () => {
  const out = validateFinalPrep({
    whyThisRole: 'x',
    longTermFraming: 'y',
    mutualFitTalkingPoints: [
      { point: 'a', grounding: 'b' },
      { point: '  ', grounding: '' },
    ],
    substantiveQuestions: [
      { question: 'q', rationale: 'r' },
      { question: '', rationale: '' },
    ],
  })!;
  expect(out.mutualFitTalkingPoints).toHaveLength(1);
  expect(out.substantiveQuestions).toHaveLength(1);
  expect(out.whyThisRole).toBe('x');
});

it('returns undefined on undefined', () => {
  expect(validateFinalPrep(undefined)).toBeUndefined();
});
