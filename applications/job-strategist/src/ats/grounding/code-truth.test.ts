/** @format */
import { repoOf, buildCodeStackContext, demoteCodeContradictedMatches } from './code-truth.js';
import * as shared from '@bedrock/shared';
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

    // Each must stay VERIFIED — the contradiction must NOT fire.
    it.each([
        ['predecessor still in code (no migration)', verified('Self-hosted Kubernetes', [CDK_DOC]),
            { ...DEPS, codeTechByRepo: new Map([['Nelson-Lamounier/cdk-monitoring', new Set(['self_hosted_kubernetes', 'kubernetes'])]]) }],
        ['no successor present in code', verified('Self-hosted Kubernetes', [CDK_DOC]),
            { ...DEPS, codeTechByRepo: new Map([['Nelson-Lamounier/cdk-monitoring', new Set(['kubernetes', 'argocd'])]]) }],
        ['no evidence files (career evidence, not repo-scoped)', verified('Self-hosted Kubernetes', []), DEPS],
        ['repo with no code truth', verified('Self-hosted Kubernetes', ['Other/unknown-repo/docs/x.md']), DEPS],
        // PEER-PREDECESSOR GUARD (F11): kubeadm and self_hosted_kubernetes are both
        // predecessors of aws_eks. self_hosted_kubernetes (the peer) is still current
        // in code, so the kubeadm claim must NOT be demoted — same guard migration-reframe
        // already applies (grounding/succeeds-edges.ts), now shared with code-truth.
        ['a PEER predecessor of the same successor is still current in code', verified('Migrated a kubeadm control plane to managed EKS', [CDK_DOC]),
            { ...DEPS, codeTechByRepo: new Map([['Nelson-Lamounier/cdk-monitoring', new Set(['aws_eks', 'self_hosted_kubernetes', 'kubernetes'])]]) }],
    ])('KEEPS the claim: %s', (_label, match, deps) => {
        const r = demoteCodeContradictedMatches(matching([match]), deps);
        expect(r.matching.verifiedMatches).toHaveLength(1);
        expect(r.contradictions).toHaveLength(0);
    });

    it('DOES demote when no peer predecessor is current (the genuine stale case)', () => {
        // Neither self_hosted_kubernetes nor kubeadm is present in code — no peer to protect it.
        const r = demoteCodeContradictedMatches(
            matching([verified('Migrated a kubeadm control plane to managed EKS', [CDK_DOC])]),
            DEPS,
        );
        expect(r.matching.verifiedMatches).toHaveLength(0);
        expect(r.contradictions).toHaveLength(1);
        expect(r.contradictions[0]).toMatchObject({ docTech: 'kubeadm', codeSuccessors: ['aws_eks'] });
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

    describe('fail-open telemetry', () => {
        it('warns when SKIPPED because succeedsEdges/codeTechByRepo is empty (possible ontology load failure)', () => {
            const warnSpy = jest.spyOn(shared, 'log').mockImplementation(() => undefined);
            demoteCodeContradictedMatches(matching([verified('Self-hosted Kubernetes', [CDK_DOC])]), { ...DEPS, succeedsEdges: new Map() });
            expect(warnSpy).toHaveBeenCalledWith('WARN', expect.stringMatching(/skipped/i), expect.any(Object));
            warnSpy.mockRestore();
        });

        it('does NOT warn when the guard RAN and found 0 contradictions', () => {
            const warnSpy = jest.spyOn(shared, 'log').mockImplementation(() => undefined);
            const r = demoteCodeContradictedMatches(matching([verified('Python automation', [CDK_DOC])]), DEPS);
            expect(r.contradictions).toHaveLength(0);
            expect(warnSpy).not.toHaveBeenCalled();
            warnSpy.mockRestore();
        });
    });
});
