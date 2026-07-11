/**
 * @format
 * Strategist projects[].highlights eval (CLAUDE.md §5).
 *
 * Regression guard for the defect where the writer emitted a single thin prose
 * `description` per project and NEVER surfaced the per-angle PROJECT RESUME
 * BULLETS — throwing away the candidate's strongest, JD-aligned technical
 * evidence (observed live on the eBay DevOps run: ATS grounded coverage 46%).
 *
 * Good output = 2-4 highlights per project, each grounded in the block (no
 * invention), with the block-supported JD must-haves actually surfaced.
 * Deterministic grader → gates CI without a live model call.
 */
import { describe, it, expect } from '@jest/globals';
import { gradeProjectHighlights } from './project-highlights-guard.js';

/** Real-shaped PROJECT RESUME BULLETS block (infrastructure angle, two projects). */
const BLOCK = [
    '## frontend-portfolio',
    '[angle: infrastructure]',
    '- Designed fully automated zero-downtime blue-green deploys on self-managed EKS: GitHub Actions writes ECR digest to SSM Parameter Store; ArgoCD Image Updater + Argo Rollouts auto-promotes with an analysis template — no kubectl from CI',
    '- Instrumented browser-to-pod observability end-to-end: Grafana Faro RUM to Alloy to Loki/Tempo, prom-client metrics scraped by Prometheus; live quality assessment rated 85% overall (LCP 132 ms, TTFB 40 ms)',
    '## AI Applications Platform',
    '[angle: infrastructure]',
    '- Provisioned production EKS cluster (Kubernetes 1.34, eu-west-1) via a 16-CDK-stack monorepo with Karpenter autoscaling, Pod Identity, Argo Rollouts blue/green, and regional WAFv2 WebACL on the shared ALB',
    '- Built artifact-based CI image handoff (replacing LRU-evictable actions/cache) across all model Job deploy workflows, eliminating intermittent deploy failures under cache pressure',
].join('\n');

/** Must-haves the eBay JD names; only some are supported by the block above. */
const JD_MUST_HAVES = ['GitHub Actions', 'autoscaling', 'observability', 'Karpenter', 'Jenkins', 'GitLab CI'];

/** GOOD: 2 highlights per project, each a trimmed quote from the block. */
const GOOD = [
    {
        name: 'frontend-portfolio',
        highlights: [
            'Designed fully automated zero-downtime blue-green deploys on self-managed EKS: GitHub Actions writes ECR digest to SSM Parameter Store; ArgoCD Image Updater + Argo Rollouts auto-promotes — no kubectl from CI',
            'Instrumented browser-to-pod observability end-to-end: Grafana Faro RUM to Alloy to Loki/Tempo, prom-client metrics scraped by Prometheus',
        ],
    },
    {
        name: 'AI Applications Platform',
        highlights: [
            'Provisioned production EKS cluster via a 16-CDK-stack monorepo with Karpenter autoscaling, Pod Identity, Argo Rollouts blue/green, and regional WAFv2 WebACL on the shared ALB',
            'Built artifact-based CI image handoff replacing LRU-evictable actions/cache across all model Job deploy workflows, eliminating intermittent deploy failures under cache pressure',
        ],
    },
];

/**
 * BAD: one project mixes a valid quote with an INVENTED bullet (Jenkins / macOS
 * fleets — facts absent from the block), the other is left as prose only (no
 * highlights), dropping its block-supported must-haves.
 */
const BAD = [
    {
        name: 'frontend-portfolio',
        highlights: [
            'Instrumented browser-to-pod observability end-to-end: Grafana Faro RUM to Alloy to Loki/Tempo',
            'Operated high-throughput Jenkins pipelines orchestrating macOS Xcode build fleets with capacity planning across Android runners',
        ],
    },
    {
        name: 'AI Applications Platform',
        highlights: [],
    },
];

describe('projects[].highlights — grounded, JD-aligned, non-empty (eBay DevOps regression)', () => {
    it('GOOD: passes — 2-4 grounded highlights per project', () => {
        const g = gradeProjectHighlights(GOOD, BLOCK, { groundedMustHaves: JD_MUST_HAVES });
        expect(g.pass).toBe(true);
        expect(g.reasons).toEqual([]);
        expect(g.projectsWithHighlights).toBe(2);
        expect(g.ungroundedHighlights).toEqual([]);
    });

    it('GOOD: surfaces the block-supported must-haves, and does NOT demand unsupported ones', () => {
        const g = gradeProjectHighlights(GOOD, BLOCK, { groundedMustHaves: JD_MUST_HAVES });
        // Supported by the block → must surface.
        expect(g.mustHavesSurfaced).toEqual(expect.arrayContaining(['GitHub Actions', 'autoscaling', 'observability', 'Karpenter']));
        // Jenkins / GitLab CI are NOT in the block (candidate has no such evidence)
        // → the grader must never flag them missing (honest omission, no invention).
        expect(g.mustHavesMissed).toEqual([]);
    });

    it('BAD: fails — invented highlight + a project with none', () => {
        const g = gradeProjectHighlights(BAD, BLOCK, { groundedMustHaves: JD_MUST_HAVES });
        expect(g.pass).toBe(false);
        expect(g.ungroundedHighlights.length).toBeGreaterThan(0);
        // The invented Jenkins/macOS/Android bullet is not grounded in the block.
        expect(g.ungroundedHighlights[0]).toContain('Jenkins');
        // The empty project drops a block-supported must-have (e.g. Karpenter).
        expect(g.mustHavesMissed.length).toBeGreaterThan(0);
    });

    it('omitting highlights is allowed only when the block has no evidence for that project', () => {
        const noEvidence = [{ name: 'unlisted-side-project', highlights: [] }];
        const g = gradeProjectHighlights(noEvidence, BLOCK, {});
        expect(g.pass).toBe(true);
    });
});
