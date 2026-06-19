/** @format */
import { computeEnrichEvalMetrics } from './enrichEvalMetrics.js';

const m = (entries: [string, string[]][]): Map<string, string[]> => new Map(entries);

describe('computeEnrichEvalMetrics', () => {
    it('perfect match → recall 1, precision 1, no added/dropped', () => {
        const base = m([['f::0', ['kubernetes']], ['f::1', ['react']]]);
        const r = computeEnrichEvalMetrics(base, base);
        expect(r.recall).toBe(1);
        expect(r.precision).toBe(1);
        expect(r.addedSkills).toBe(0);
        expect(r.droppedSkills).toBe(0);
    });

    it('candidate drops a baseline skill → recall < 1, counted dropped', () => {
        const base = m([['f::0', ['kubernetes', 'helm']]]);
        const cand = m([['f::0', ['kubernetes']]]);
        const r = computeEnrichEvalMetrics(base, cand);
        expect(r.recall).toBe(0.5);   // kept 1 of 2
        expect(r.precision).toBe(1);  // nothing wrong added
        expect(r.droppedSkills).toBe(1);
    });

    it('candidate adds an unevidenced skill → precision < 1, counted added (the smear it must catch)', () => {
        const base = m([['f::0', ['kubernetes']]]);
        const cand = m([['f::0', ['kubernetes', 'react']]]); // react smeared from elsewhere in the file
        const r = computeEnrichEvalMetrics(base, cand);
        expect(r.recall).toBe(1);
        expect(r.precision).toBe(0.5);
        expect(r.addedSkills).toBe(1);
    });

    it('empty baseline chunk contributes recall 1; empty candidate contributes precision 1', () => {
        const base = m([['f::0', []]]);
        const cand = m([['f::0', []]]);
        const r = computeEnrichEvalMetrics(base, cand);
        expect(r.recall).toBe(1);
        expect(r.precision).toBe(1);
    });
});
