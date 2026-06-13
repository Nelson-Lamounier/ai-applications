/** @format */
import { detectStaleMigrations } from './migration-reframe.js';
import type { StructuredResumeData } from '@bedrock/shared';

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
// Current code uses EKS, no self-hosted/kubeadm → migration occurred.
const CODE_EKS = new Map<string, Set<string>>([['o/kubernetes-bootstrap', new Set(['aws_eks', 'kubernetes'])]]);

const resumeWith = (...highlights: string[]): StructuredResumeData =>
    ({ experience: [{ company: 'Freelance', title: 'Cloud & DevOps Engineer', period: '2022-2024', highlights }] } as unknown as StructuredResumeData);

const DEPS = { succeedsEdges: SUCCEEDS, codeTechByRepo: CODE_EKS, aliasToCanonical: ALIAS };

describe('detectStaleMigrations', () => {
    it('flags a bullet describing a superseded tech (kubeadm → EKS)', () => {
        const r = detectStaleMigrations(resumeWith('Built a self-managed Kubernetes cluster via kubeadm on AWS EC2'), DEPS);
        expect(r).toHaveLength(1);
        expect(r[0]).toMatchObject({ predecessor: expect.stringMatching(/kubeadm|self_hosted_kubernetes/), successors: ['aws_eks'] });
    });

    it('does NOT flag when the predecessor is STILL in the code (no migration)', () => {
        const code = new Map([['o/r', new Set(['self_hosted_kubernetes', 'aws_eks'])]]);
        const r = detectStaleMigrations(resumeWith('Self-hosted Kubernetes via kubeadm'), { ...DEPS, codeTechByRepo: code });
        expect(r).toHaveLength(0);
    });

    it('does NOT flag when no successor is present in the code', () => {
        const code = new Map([['o/r', new Set(['kubernetes', 'argocd'])]]);
        const r = detectStaleMigrations(resumeWith('Self-hosted Kubernetes via kubeadm'), { ...DEPS, codeTechByRepo: code });
        expect(r).toHaveLength(0);
    });

    it('does NOT flag a bullet that does not name a predecessor', () => {
        const r = detectStaleMigrations(resumeWith('Deployed 25 ArgoCD-managed applications on managed EKS'), DEPS);
        expect(r).toHaveLength(0);
    });

    it('flags each offending bullet across roles', () => {
        const resume = {
            experience: [
                { company: 'A', title: 'X', period: 'p', highlights: ['Operated a self-hosted Kubernetes cluster'] },
                { company: 'B', title: 'Y', period: 'p', highlights: ['Built CI/CD pipelines', 'bootstrapped a kubeadm control plane'] },
            ],
        } as unknown as StructuredResumeData;
        const r = detectStaleMigrations(resume, DEPS);
        expect(r).toHaveLength(2);
    });

    it('flags a stale claim in the SUMMARY, not just experience highlights', () => {
        const resume = {
            summary: 'Shipped 25 ArgoCD apps in a self-hosted Kubernetes environment.',
            experience: [],
        } as unknown as StructuredResumeData;
        const r = detectStaleMigrations(resume, DEPS);
        expect(r).toHaveLength(1);
        expect(r[0].successors).toEqual(['aws_eks']);
    });

    it('flags a stale claim in keyAchievements (achievement string)', () => {
        const resume = {
            experience: [],
            keyAchievements: [{ achievement: 'Operated a self-hosted Kubernetes cluster via kubeadm.' }],
        } as unknown as StructuredResumeData;
        const r = detectStaleMigrations(resume, DEPS);
        expect(r).toHaveLength(1);
    });

    it('FAIL-SAFE: no succeeds edges → no flags', () => {
        expect(detectStaleMigrations(resumeWith('Self-hosted Kubernetes via kubeadm'), { ...DEPS, succeedsEdges: new Map() })).toHaveLength(0);
    });

    it('FAIL-SAFE: no code evidence → no flags', () => {
        expect(detectStaleMigrations(resumeWith('Self-hosted Kubernetes via kubeadm'), { ...DEPS, codeTechByRepo: new Map() })).toHaveLength(0);
    });
});
