/** @format */
import { describe, it, expect } from '@jest/globals';
import { scoreSkillResolution, type ResolutionOutcome } from './evaluateSkillResolution.js';

const o = (phrase: string, expected: string | null, resolved: string | null): ResolutionOutcome =>
    ({ phrase, expected, resolved });

describe('scoreSkillResolution', () => {
    it('recall = fraction of should-match cases resolved to the right canonical', () => {
        const s = scoreSkillResolution([
            o('k8s net', 'kubernetes networking', 'kubernetes networking'), // hit
            o('cdk stack', 'iac with cdk', 'iac with cdk'),                 // hit
            o('rest endpoints', 'rest api design', null),                   // miss (resolved nothing)
        ]);
        expect(s.positives).toBe(3);
        expect(s.recall).toBeCloseTo(2 / 3, 5);
    });

    it('precision = fraction of resolved (non-null) cases that match the expected canonical', () => {
        const s = scoreSkillResolution([
            o('k8s net', 'kubernetes networking', 'kubernetes networking'), // correct
            o('weird phrase', 'rest api design', 'iac with cdk'),           // resolved WRONG
            o('novel thing', null, null),                                   // correctly unresolved
        ]);
        // two resolved non-null: one correct, one wrong -> precision 0.5
        expect(s.precision).toBeCloseTo(0.5, 5);
    });

    it('falseMergeRate = fraction of should-NOT-match cases that were wrongly resolved', () => {
        const s = scoreSkillResolution([
            o('genuinely novel a', null, null),               // correct (stayed raw)
            o('genuinely novel b', null, 'observability'),    // false merge
            o('genuinely novel c', null, null),               // correct
        ]);
        expect(s.negatives).toBe(3);
        expect(s.falseMergeRate).toBeCloseTo(1 / 3, 5);
    });

    it('handles all-positive and all-negative sets without divide-by-zero', () => {
        expect(scoreSkillResolution([o('a', 'x', 'x')]).falseMergeRate).toBe(0);
        expect(scoreSkillResolution([o('a', null, null)]).recall).toBe(0);
        expect(scoreSkillResolution([]).precision).toBe(0);
    });
});
