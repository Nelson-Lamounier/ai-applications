/** @format */
import { loadProfilePositioning } from './profile-intelligence.js';

function makePool(direction: unknown) {
    return { query: async () => ({ rows: direction === undefined ? [] : [{ direction }] }) } as never;
}

describe('loadProfilePositioning', () => {
    it('formats the strongest seniority areas with evidence', async () => {
        const out = await loadProfilePositioning(makePool({
            seniority: [
                { area: 'Platform & Kubernetes Engineering', level: 'senior', evidence: 'EKS, Karpenter, ArgoCD across 3 repos' },
                { area: 'Cloud Infrastructure (AWS)', level: 'senior', evidence: 'VPC, IAM, WAF' },
            ],
        }), 'u1');
        expect(out).toContain('Positioning signal');
        expect(out).toContain('Platform & Kubernetes Engineering: senior');
        expect(out).toContain('EKS, Karpenter');
    });

    it('returns empty string when no rollup row exists (fail-open)', async () => {
        expect(await loadProfilePositioning(makePool(undefined), 'u1')).toBe('');
    });

    it('returns empty string when direction has no seniority', async () => {
        expect(await loadProfilePositioning(makePool({}), 'u1')).toBe('');
    });
});
