/** @format */
import { computeSemanticEvalMetrics, type SkillSim } from './semanticEvalMetrics.js';

const m = (entries: [string, string[]][]): Map<string, string[]> => new Map(entries);

// A stub similarity: paraphrase pairs are "near" (0.95), everything else far (0.1).
const PARAPHRASE: Record<string, string> = {
    'iac with cdk': 'infrastructure as code with cdk',
    'infrastructure as code with cdk': 'iac with cdk',
    'k8s networking': 'kubernetes networking',
    'kubernetes networking': 'k8s networking',
};
const stubSim: SkillSim = (a, b) => (PARAPHRASE[a] === b ? 0.95 : 0.1);

describe('computeSemanticEvalMetrics', () => {
    it('credits a paraphrase that exact-string would score as a miss', () => {
        const base = m([['c0', ['iac with cdk']]]);
        const cand = m([['c0', ['infrastructure as code with cdk']]]);
        const r = computeSemanticEvalMetrics(base, cand, stubSim, 0.8);
        expect(r.recall).toBe(1);      // semantic match, not 0 like exact-string
        expect(r.precision).toBe(1);
    });

    it('still credits an exact match (sim=1 short-circuit)', () => {
        const base = m([['c0', ['terraform']]]);
        const r = computeSemanticEvalMetrics(base, base, stubSim, 0.8);
        expect(r.recall).toBe(1);
        expect(r.precision).toBe(1);
    });

    it('counts a genuinely-different skill as a miss (not a paraphrase)', () => {
        const base = m([['c0', ['kubernetes networking', 'terraform']]]);
        const cand = m([['c0', ['k8s networking']]]);   // matches 1 of 2 (paraphrase); terraform missing
        const r = computeSemanticEvalMetrics(base, cand, stubSim, 0.8);
        expect(r.recall).toBe(0.5);    // 1 of 2 baseline matched
        expect(r.precision).toBe(1);   // the 1 candidate matched a baseline
    });

    it('respects the threshold (a near-but-below pair is a miss)', () => {
        const base = m([['c0', ['iac with cdk']]]);
        const cand = m([['c0', ['infrastructure as code with cdk']]]);
        const r = computeSemanticEvalMetrics(base, cand, stubSim, 0.99); // 0.95 < 0.99
        expect(r.recall).toBe(0);
    });

    it('empty baseline → recall 1; empty candidate → precision 1', () => {
        const r = computeSemanticEvalMetrics(m([['c0', []]]), m([['c0', []]]), stubSim, 0.8);
        expect(r.recall).toBe(1);
        expect(r.precision).toBe(1);
    });
});
