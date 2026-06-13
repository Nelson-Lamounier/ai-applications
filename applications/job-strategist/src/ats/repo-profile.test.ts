/** @format */
import { buildRepoProfiles, buildRepoProfileContext } from './repo-profile.js';
import type { Signals } from './repo-profile.js';

const tech = (...t: string[]) => new Set(t);
const sig = (o: Record<string, boolean>): Signals => o;

describe('buildRepoProfiles', () => {
    it('classifies a CDK repo that provisions EKS (the cdk-monitoring case)', () => {
        const profiles = buildRepoProfiles(
            new Map([['Nelson-Lamounier/cdk-monitoring', tech('aws_cdk', 'aws_eks', 'aws_ec2', 'cloudformation', 'argocd')]]),
            new Map([['Nelson-Lamounier/cdk-monitoring', sig({ has_iac: true, has_k8s_manifests: true, has_dockerfile: true, has_deployment_workflow: true })]]),
        );
        expect(profiles).toHaveLength(1);
        const p = profiles[0];
        expect(p.repoType).toBe('cdk-infra');
        expect(p.frameworks).toEqual(['aws_cdk', 'argocd', 'cloudformation'].sort((a, b) => a.localeCompare(b)));
        expect(p.services).toEqual(['aws_ec2', 'aws_eks']);
        expect(p.concepts).toContain('provisions-managed-kubernetes');
        expect(p.concepts).toContain('aws-native-iac');
    });

    it('classifies a gitops k8s-platform repo (kubernetes-bootstrap)', () => {
        const [p] = buildRepoProfiles(
            new Map([['o/kubernetes-bootstrap', tech('kubernetes', 'helm')]]),
            new Map([['o/kubernetes-bootstrap', sig({ has_iac: true, has_k8s_manifests: true, has_argocd_apps: true, has_helm_chart: true })]]),
        );
        // has_iac true but no cdk/terraform framework → falls through to k8s-platform
        expect(p.repoType).toBe('k8s-platform');
        expect(p.concepts).toContain('gitops');
        expect(p.services).toContain('kubernetes');
    });

    it('classifies a plain application (docker only, no iac/k8s)', () => {
        const [p] = buildRepoProfiles(
            new Map([['o/tucaken-app', tech('typescript', 'react')]]),
            new Map([['o/tucaken-app', sig({ has_dockerfile: true, has_ci: true })]]),
        );
        expect(p.repoType).toBe('application');
        expect(p.concepts).toContain('containerized');
        expect(p.services).toEqual([]); // no provisioned cloud services
    });

    it('frameworks/services come ONLY from code tech, never from signals', () => {
        const [p] = buildRepoProfiles(
            new Map([['o/r', tech('aws_eks')]]), // code has eks…
            new Map([['o/r', sig({ has_iac: true })]]), // …but no cdk in tech, no k8s/helm/argocd signal
        );
        expect(p.frameworks).toEqual([]);           // no cdk/terraform in tech → no framework claimed
        expect(p.services).toEqual(['aws_eks']);    // service IS drawn from code tech
        expect(p.repoType).toBe('application');     // has_iac alone (no framework, no k8s signal) → safe default
    });

    it('classifies an ML repo', () => {
        const [p] = buildRepoProfiles(new Map(), new Map([['o/ml', sig({ notebook_heavy: true })]]));
        expect(p.repoType).toBe('ml');
    });

    it('skips repos with neither tech nor signals', () => {
        expect(buildRepoProfiles(new Map([['o/empty', new Set<string>()]]), new Map())).toHaveLength(0);
    });
});

describe('buildRepoProfileContext', () => {
    it('renders an identity line per repo with the authoritative header', () => {
        const block = buildRepoProfileContext(buildRepoProfiles(
            new Map([['Nelson-Lamounier/cdk-monitoring', tech('aws_cdk', 'aws_eks')]]),
            new Map([['Nelson-Lamounier/cdk-monitoring', sig({ has_iac: true })]]),
        ));
        expect(block).toMatch(/Repository Profiles/);
        expect(block).toMatch(/cdk-monitoring \[cdk-infra\]/);
        expect(block).toMatch(/aws eks/);
    });
    it('returns empty string for no profiles', () => {
        expect(buildRepoProfileContext([])).toBe('');
    });
});
