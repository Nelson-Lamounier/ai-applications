/** @format */
import { describe, it, expect } from '@jest/globals';
import { resolveSummaryAts } from '../summary-ats-flow.js';

const targets = [
  { skill: 'Kubernetes', source: 'hard' as const, verdict: 'verified' as const },
  { skill: 'AWS', source: 'hard' as const, verdict: 'verified' as const },
  { skill: 'Terraform', source: 'hard' as const, verdict: 'transferable' as const },
];
const cleanGuard = (_s: string) => null;

describe('resolveSummaryAts', () => {
  it('fires a re-write when covered<2 and keeps it when it covers more (guards clean)', async () => {
    const r = await resolveSummaryAts({
      firstSummary: 'Ships reliably on Kubernetes.',            // covers 1 (<2)
      targets,
      guard: cleanGuard,
      rewrite: async () => 'Ships on Kubernetes, AWS, and Terraform.', // covers 3
    });
    expect(r.diag.coverageBefore.covered).toBe(1);
    expect(r.diag.rewrite.fired).toBe(true);
    expect(r.diag.rewrite.kept).toBe('rewrite');
    expect(r.diag.rewrite.coverageAfter?.covered).toBe(3);
    expect(r.summary).toBe('Ships on Kubernetes, AWS, and Terraform.');
  });

  it('keeps first when the re-write gains no coverage', async () => {
    const r = await resolveSummaryAts({
      firstSummary: 'Ships on Kubernetes.',                     // covers 1
      targets,
      guard: cleanGuard,
      rewrite: async () => 'Deploys on Kubernetes daily.',      // still covers 1
    });
    expect(r.diag.rewrite.fired).toBe(true);
    expect(r.diag.rewrite.kept).toBe('first');
    expect(r.diag.rewrite.keptReason).toBe('no-coverage-gain');
    expect(r.summary).toBe('Ships on Kubernetes.');
  });

  it('does not fire a re-write when coverage already >=2', async () => {
    let called = false;
    const r = await resolveSummaryAts({
      firstSummary: 'Ships on Kubernetes and AWS.',             // covers 2
      targets,
      guard: cleanGuard,
      rewrite: async () => { called = true; return 'x'; },
    });
    expect(called).toBe(false);
    expect(r.diag.rewrite.fired).toBe(false);
    expect(r.summary).toBe('Ships on Kubernetes and AWS.');
  });

  it('does not fire a re-write when the guard fails but coverage is already met', async () => {
    let called = false;
    const guard = (s: string) => (s.includes('lack') ? 'namesGap' : null);
    const r = await resolveSummaryAts({
      firstSummary: 'Ships on Kubernetes and AWS but lacks depth.', // covers 2, guard-fails
      targets,
      guard,
      rewrite: async () => { called = true; return 'x'; },
    });
    expect(called).toBe(false);
    expect(r.diag.rewrite.fired).toBe(false);
    expect(r.diag.rewrite.reason).toBe('coverage-met');
    expect(r.summary).toBe('Ships on Kubernetes and AWS but lacks depth.');
    expect(r.diag.guardRejections).toContain('first:namesGap');
  });

  it('keeps first when the re-write throws', async () => {
    const r = await resolveSummaryAts({
      firstSummary: 'Ships on Kubernetes.',
      targets,
      guard: cleanGuard,
      rewrite: async () => { throw new Error('bedrock 500'); },
    });
    expect(r.diag.rewrite.fired).toBe(true);
    expect(r.diag.rewrite.kept).toBe('first');
    expect(r.summary).toBe('Ships on Kubernetes.');
  });

  it('prefers the re-write when the first fails the guard but the re-write passes', async () => {
    const guard = (s: string) => (s.includes('lack') ? 'namesGap' : null);
    const r = await resolveSummaryAts({
      firstSummary: 'Ships on Kubernetes; lacks broader depth.', // covers 1 (K8s only), guard-fails
      targets,
      guard,
      rewrite: async () => 'Ships on Kubernetes and AWS.',      // covers 2, guard clean
    });
    expect(r.diag.rewrite.kept).toBe('rewrite');
    expect(r.diag.guardRejections).toContain('first:namesGap');
    expect(r.summary).toBe('Ships on Kubernetes and AWS.');
  });

  it('does nothing when there are no targets', async () => {
    let called = false;
    const r = await resolveSummaryAts({
      firstSummary: 'Solid engineer.',
      targets: [],
      guard: cleanGuard,
      rewrite: async () => { called = true; return 'x'; },
    });
    expect(called).toBe(false);
    expect(r.diag.rewrite.fired).toBe(false);
    expect(r.summary).toBe('Solid engineer.');
  });
});
