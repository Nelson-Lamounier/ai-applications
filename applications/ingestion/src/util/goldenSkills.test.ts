/** @format */
import { loadGoldenSet, goldenToMap } from './goldenSkills.js';
import { computeSemanticEvalMetrics, type SkillSim } from './semanticEvalMetrics.js';

describe('golden skill set', () => {
    it('loads the committed fixture (21 chunks, every chunk has skills)', () => {
        const g = loadGoldenSet();
        expect(g.chunks.length).toBeGreaterThanOrEqual(20);
        expect(g.chunks.every((c) => c.id && c.skills.length > 0)).toBe(true);
    });

    it('canonicalises to an id -> skills map', () => {
        const map = goldenToMap(loadGoldenSet());
        // the cluster-autoscaler chunk
        expect(map.get('5b07a32c-bd8c-42e1-a6da-9cfd57c9c0db')).toEqual(
            expect.arrayContaining(['argocd', 'gitops', 'kubernetes', 'cluster autoscaler', 'autoscaling', 'helm charts']),
        );
    });
});

// Local validation of the SCORING methodology against golden — NO model call.
describe('scoring a hand candidate against golden (methodology check)', () => {
    // stub sim: known paraphrase pairs are near; everything else far.
    const NEAR: Record<string, string> = { 'argo cd': 'argocd', 'argocd': 'argo cd', 'k8s': 'kubernetes', 'kubernetes': 'k8s' };
    const sim: SkillSim = (a, b) => (NEAR[a] === b ? 0.95 : 0.1);

    const goldenSubset = new Map<string, string[]>([
        ['c', ['argocd', 'gitops', 'kubernetes', 'cluster autoscaler', 'autoscaling', 'helm charts']],
    ]);

    it('a partial, paraphrased candidate scores high precision (all valid) + partial recall', () => {
        // candidate: 3 valid skills, one phrased "argo cd", one "k8s" — all in the golden union semantically.
        const candidate = new Map<string, string[]>([['c', ['argo cd', 'k8s', 'cluster autoscaler']]]);
        const r = computeSemanticEvalMetrics(goldenSubset, candidate, sim, 0.8);
        expect(r.precision).toBe(1);             // every candidate skill is valid (in golden)
        expect(r.recall).toBeCloseTo(3 / 6);     // found 3 of the 6 golden skills (argocd≈argo cd, k8s≈kubernetes, cluster autoscaler)
    });

    it('an invalid (hallucinated) candidate skill drops precision — the key signal vs sample-vs-sample', () => {
        const candidate = new Map<string, string[]>([['c', ['argocd', 'blockchain']]]);   // blockchain not evidenced
        const r = computeSemanticEvalMetrics(goldenSubset, candidate, sim, 0.8);
        expect(r.precision).toBe(0.5);           // 1 of 2 candidate skills valid -> caught the hallucination
    });
});
