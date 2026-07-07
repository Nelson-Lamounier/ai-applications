/** @format */
import { describe, it, expect } from '@jest/globals';
import { deriveDepthMarkers } from './case-study-depth.js';
import type { DepthSignals } from './case-study-depth.js';

const sig = (over: Partial<DepthSignals> = {}): DepthSignals => ({
    laneCounts: {}, archetype: {}, ...over,
});

describe('deriveDepthMarkers', () => {
    it('grounds test coverage from the test/source ratio', () => {
        expect(deriveDepthMarkers(sig({ laneCounts: { source: 100, test: 640 } })).testCoverageSignal).toBe('strong');
        expect(deriveDepthMarkers(sig({ laneCounts: { source: 100, test: 30 } })).testCoverageSignal).toBe('moderate');
        expect(deriveDepthMarkers(sig({ laneCounts: { source: 100, test: 5 } })).testCoverageSignal).toBe('light');
        expect(deriveDepthMarkers(sig({ laneCounts: { source: 100, test: 0 } })).testCoverageSignal).toBe('none');
        expect(deriveDepthMarkers(sig({ laneCounts: { source: 100, test: 640 } })).hasTests).toBe(true);
    });

    it('grades CI maturity from archetype signals (argocd → multi_env)', () => {
        expect(deriveDepthMarkers(sig({ archetype: { has_ci: true, has_argocd_apps: true } })).ciMaturity).toBe('multi_env');
        expect(deriveDepthMarkers(sig({ archetype: { has_ci: true, has_deployment_workflow: true } })).ciMaturity).toBe('deploys_to_prod');
        expect(deriveDepthMarkers(sig({ archetype: { has_ci: true } })).ciMaturity).toBe('basic');
        expect(deriveDepthMarkers(sig({})).ciMaturity).toBe('none');
        expect(deriveDepthMarkers(sig({ laneCounts: { ci: 57 } })).hasCi).toBe(true); // ci lane implies CI
    });

    it('flags deployment evidence from IaC / argocd / docker / iac lane', () => {
        expect(deriveDepthMarkers(sig({ archetype: { has_argocd_apps: true } })).hasDeploymentEvidence).toBe(true);
        expect(deriveDepthMarkers(sig({ laneCounts: { iac: 45 } })).hasDeploymentEvidence).toBe(true);
        expect(deriveDepthMarkers(sig({})).hasDeploymentEvidence).toBe(false);
    });

    it('derives documentation density', () => {
        expect(deriveDepthMarkers(sig({ archetype: { has_docs_site_config: true } })).documentationDensity).toBe('comprehensive');
        expect(deriveDepthMarkers(sig({ laneCounts: { docs: 40 } })).documentationDensity).toBe('docs_dir');
        expect(deriveDepthMarkers(sig({ laneCounts: { docs: 2 } })).documentationDensity).toBe('readme_only');
        expect(deriveDepthMarkers(sig({})).documentationDensity).toBe('none');
    });

    it('carries refactorCount + deploymentUrl, clamped', () => {
        const d = deriveDepthMarkers(sig({ refactorCount: 7.9, deploymentUrl: 'https://x.dev' }));
        expect(d.refactorCount).toBe(7);
        expect(d.deploymentUrl).toBe('https://x.dev');
    });

    it('the live project (ai-applications) reads strong tests + GitOps CI + deploy evidence', () => {
        const d = deriveDepthMarkers(sig({
            laneCounts: { source: 141, test: 640, ci: 36, iac: 45, docs: 30 },
            archetype: { has_ci: true, has_argocd_apps: true, has_iac: true, has_dockerfile: true },
        }));
        expect(d).toMatchObject({ hasTests: true, testCoverageSignal: 'strong', hasCi: true, ciMaturity: 'multi_env', hasDeploymentEvidence: true });
    });
});

describe('deriveEvidenceMix', () => {
    it('splits app (source+test) vs infra (iac+ci) lanes into rounded-to-5 percentages', async () => {
        const { deriveEvidenceMix } = await import('./case-study-depth.js');
        const mix = deriveEvidenceMix({ source: 141, test: 640, iac: 45, ci: 0, docs: 200, config: 30 });
        // 781 app vs 45 infra = 94.6% → nearest 5 = 95/5. docs/config excluded.
        expect(mix).toEqual({ appPct: 95, infraPct: 5, appFiles: 781, infraFiles: 45 });
    });

    it('returns null when either lane is empty (nothing to balance)', async () => {
        const { deriveEvidenceMix } = await import('./case-study-depth.js');
        expect(deriveEvidenceMix({ source: 100, test: 20 })).toBeNull();
        expect(deriveEvidenceMix({ iac: 80 })).toBeNull();
        expect(deriveEvidenceMix({})).toBeNull();
    });

    it('reflects an infra-dominant project (e.g. a Terraform/CDK repo)', async () => {
        const { deriveEvidenceMix } = await import('./case-study-depth.js');
        const mix = deriveEvidenceMix({ source: 30, iac: 270 });
        expect(mix).toEqual({ appPct: 10, infraPct: 90, appFiles: 30, infraFiles: 270 });
    });
});

describe('deriveDifficultySignals', () => {
    const span = { first_commit_at: '2025-11-29T00:00:00Z', last_commit_at: '2026-07-07T00:00:00Z', total: '406' };

    it('buckets counts to the nearest 5 (floor 1) and dates to months', async () => {
        const { deriveDifficultySignals } = await import('./case-study-depth.js');
        const out = deriveDifficultySignals(
            [{ area: 'src/auth', fix_commits: '13', total_commits: '38', first_at: '2026-01-15T10:00:00Z', last_at: '2026-06-02T10:00:00Z' }],
            span,
        );
        expect(out).toEqual({
            firstCommitMonth: '2025-11',
            lastCommitMonth:  '2026-07',
            totalCommits:     405,
            areas: [{ area: 'src/auth', fixCommits: 15, totalCommits: 40, firstMonth: '2026-01', lastMonth: '2026-06' }],
        });
    });

    it('keeps tiny counts visible instead of rounding them to zero', async () => {
        const { deriveDifficultySignals } = await import('./case-study-depth.js');
        const out = deriveDifficultySignals(
            [{ area: 'infra/lib', fix_commits: '1', total_commits: '2', first_at: '2026-05-01T00:00:00Z', last_at: '2026-05-02T00:00:00Z' }],
            span,
        );
        expect(out?.areas[0]).toMatchObject({ fixCommits: 1, totalCommits: 1 });
    });

    it('returns null when no fix-dense areas exist (block omitted from the prompt)', async () => {
        const { deriveDifficultySignals } = await import('./case-study-depth.js');
        expect(deriveDifficultySignals([], span)).toBeNull();
        expect(deriveDifficultySignals([{ area: 'a', fix_commits: '1', total_commits: '1', first_at: '2026-01-01T00:00:00Z', last_at: '2026-01-01T00:00:00Z' }], null)).toBeNull();
    });
});
