/** @format */
import { repoOf, buildCodeStackContext, demoteCodeContradictedMatches } from './code-truth.js';
import type { ResearchMatching, VerifiedMatch } from '@bedrock/shared';

const CDK_DOC = 'Nelson-Lamounier/cdk-monitoring/docs/architecture/kubernetes.md';

// Code truth: cdk-monitoring migrated to EKS; aws_eks present, self_hosted_kubernetes/kubeadm absent.
const CODE = new Map<string, Set<string>>([
    ['Nelson-Lamounier/cdk-monitoring', new Set(['aws_eks', 'kubernetes', 'argocd'])],
]);
// aws_eks SUCCEEDS self_hosted_kubernetes and kubeadm → predecessor -> successors.
const SUCCEEDS = new Map<string, Set<string>>([
    ['self_hosted_kubernetes', new Set(['aws_eks'])],
    ['kubeadm', new Set(['aws_eks'])],
]);
const ALIAS = new Map<string, string>([
    ['self-hosted kubernetes', 'self_hosted_kubernetes'],
    ['self hosted kubernetes', 'self_hosted_kubernetes'],
    ['kubeadm', 'kubeadm'],
    ['eks', 'aws_eks'],
]);
const DEPS = { codeTechByRepo: CODE, succeedsEdges: SUCCEEDS, aliasToCanonical: ALIAS };

const verified = (skill: string, evidenceFiles: string[]): VerifiedMatch => ({
    skill, sourceCitation: 'KB', depth: 'working', recency: '2025', evidenceFiles,
});

const matching = (verifiedMatches: VerifiedMatch[]): ResearchMatching =>
    ({ verifiedMatches, partialMatches: [] } as unknown as ResearchMatching);

describe('repoOf', () => {
    it('extracts owner/repo from a KB path', () => {
        expect(repoOf(CDK_DOC)).toBe('Nelson-Lamounier/cdk-monitoring');
        expect(repoOf('owner/repo/a.md')).toBe('owner/repo');
    });
    it('returns null for a path without owner/repo', () => {
        expect(repoOf('justafile.md')).toBeNull();
        expect(repoOf('')).toBeNull();
    });
});

describe('buildCodeStackContext', () => {
    it('lists each repo current stack with the authoritative header', () => {
        const block = buildCodeStackContext(CODE);
        expect(block).toMatch(/AUTHORITATIVE/);
        expect(block).toMatch(/Nelson-Lamounier\/cdk-monitoring: argocd, aws eks, kubernetes/);
        expect(block).toMatch(/STALE/);
    });
    it('returns empty string when there is no code evidence', () => {
        expect(buildCodeStackContext(new Map())).toBe('');
    });
});

describe('demoteCodeContradictedMatches', () => {
    it('demotes a doc claim superseded by the code (self-hosted k8s → EKS)', () => {
        const r = demoteCodeContradictedMatches(
            matching([verified('Self-hosted Kubernetes via kubeadm', [CDK_DOC])]),
            DEPS,
        );
        expect(r.matching.verifiedMatches).toHaveLength(0);
        expect(r.matching.partialMatches).toHaveLength(1);
        expect(r.matching.partialMatches[0].framingSuggestion).toMatch(/PAST tense/);
        expect(r.matching.partialMatches[0].framingSuggestion).toMatch(/aws eks/);
        expect(r.contradictions).toHaveLength(1);
        expect(r.contradictions[0]).toMatchObject({ repo: 'Nelson-Lamounier/cdk-monitoring', docTech: 'self_hosted_kubernetes', codeSuccessors: ['aws_eks'] });
    });

    it('KEEPS the claim when the predecessor IS still in the code (no migration)', () => {
        const code = new Map([['Nelson-Lamounier/cdk-monitoring', new Set(['self_hosted_kubernetes', 'kubernetes'])]]);
        const r = demoteCodeContradictedMatches(
            matching([verified('Self-hosted Kubernetes', [CDK_DOC])]),
            { ...DEPS, codeTechByRepo: code },
        );
        expect(r.matching.verifiedMatches).toHaveLength(1);
        expect(r.contradictions).toHaveLength(0);
    });

    it('KEEPS the claim when no successor is present in the code', () => {
        const code = new Map([['Nelson-Lamounier/cdk-monitoring', new Set(['kubernetes', 'argocd'])]]);
        const r = demoteCodeContradictedMatches(
            matching([verified('Self-hosted Kubernetes', [CDK_DOC])]),
            { ...DEPS, codeTechByRepo: code },
        );
        expect(r.matching.verifiedMatches).toHaveLength(1);
        expect(r.contradictions).toHaveLength(0);
    });

    it('KEEPS a claim with no evidence files (career evidence, not repo-scoped)', () => {
        const r = demoteCodeContradictedMatches(matching([verified('Self-hosted Kubernetes', [])]), DEPS);
        expect(r.matching.verifiedMatches).toHaveLength(1);
        expect(r.contradictions).toHaveLength(0);
    });

    it('KEEPS a claim evidenced from a repo with no code truth', () => {
        const r = demoteCodeContradictedMatches(
            matching([verified('Self-hosted Kubernetes', ['Other/unknown-repo/docs/x.md'])]),
            DEPS,
        );
        expect(r.matching.verifiedMatches).toHaveLength(1);
        expect(r.contradictions).toHaveLength(0);
    });

    it('does NOT touch unrelated verified matches', () => {
        const r = demoteCodeContradictedMatches(
            matching([
                verified('Self-hosted Kubernetes via kubeadm', [CDK_DOC]),
                verified('Python automation', [CDK_DOC]),
            ]),
            DEPS,
        );
        expect(r.matching.verifiedMatches.map((v) => v.skill)).toEqual(['Python automation']);
        expect(r.matching.partialMatches).toHaveLength(1);
    });

    it('FAIL-SAFE: no succeeds edges → input returned unchanged', () => {
        const input = matching([verified('Self-hosted Kubernetes', [CDK_DOC])]);
        const r = demoteCodeContradictedMatches(input, { ...DEPS, succeedsEdges: new Map() });
        expect(r.matching).toBe(input);
        expect(r.contradictions).toHaveLength(0);
    });
});
