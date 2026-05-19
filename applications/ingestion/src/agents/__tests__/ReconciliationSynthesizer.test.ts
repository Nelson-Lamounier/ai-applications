import { ReconciliationSynthesizer } from '../ReconciliationSynthesizer.js';
import type { UserProfileRollup } from '@bedrock/shared';
import type { ResumeForReconciliation } from '@bedrock/shared';

const rollup = {
  version: 1,
  languages: [{ language: 'TypeScript', repoCount: 5, commitVolumeProxy: 400, sharePct: 70 }],
  domains: { counts: { infra: 4, web: 1 }, dominant: 'infra' },
  complexity: { simple: 1, moderate: 3, complex: 1 },
  roles: { creator: 4, maintainer: 1, contributor: 0 },
  techStackTop: [{ tech: 'AWS', repoCount: 4 }],
  activityArc: [{ repoFullName: 'o/a', lastActiveAt: '2024-01-01T00:00:00Z', primaryLanguage: 'TypeScript', domain: 'infra' }],
  totals: { projectRepoCount: 5, totalCommitVolumeProxy: 570, earliestActivity: '2024-01-01T00:00:00Z', latestActivity: '2026-01-01T00:00:00Z', activeYearsApprox: 2 },
  classificationCounts: { project: 5, hiddenCount: 0 },
  methodology: { version: 1, commitVolume: 'proxy', domainMix: 'repo-count share', scope: 's', confidence: 'c' },
} as unknown as UserProfileRollup;

const resume: ResumeForReconciliation = {
  skills: [{ category: 'Cloud', skills: ['AWS', 'Kubernetes'] }],
  experience: [{ company: 'Acme', title: 'Staff Engineer', highlights: ['Led a 12-person ML platform team'] }],
  projects: [{ name: 'infra-cli', description: 'Terraform wrapper' }],
};

function gen(out: unknown) { return { invoke: jest.fn(async () => out) }; }

describe('ReconciliationSynthesizer.synthesize', () => {
  it('returns reconciliation on a valid bidirectional grounded result', async () => {
    const s = new ReconciliationSynthesizer(gen({
      unsupportedClaims: [
        { claim: 'Led a 12-person ML platform team', resumeRef: 'Acme Staff Engineer', whyUnsupported: 'no ml domain in domain mix; role distribution is creator-heavy solo' },
      ],
      undersold: [
        { evidence: 'Heavy AWS infrastructure footprint', rollupDimension: 'tech stack', suggestion: 'Add an infrastructure-depth bullet citing AWS repos' },
      ],
    }) as never);
    const r = await s.synthesize({ rollup, resume });
    expect(r?.reconciliation.unsupportedClaims).toHaveLength(1);
    expect(r?.reconciliation.unsupportedClaims[0].resumeRef).toContain('Acme');
    expect(r?.reconciliation.undersold).toHaveLength(1);
  });

  it('drops an unsupportedClaims item whose resumeRef matches no résumé token', async () => {
    const s = new ReconciliationSynthesizer(gen({
      unsupportedClaims: [
        { claim: 'Kept grounded claim text', resumeRef: 'Acme', whyUnsupported: 'no domain evidence in the rollup' },
        { claim: 'Dropped phantom claim text', resumeRef: 'TotallyMadeUpCorp', whyUnsupported: 'pure gut feeling here' },
      ],
      undersold: [
        { evidence: 'AWS infra depth across repos', rollupDimension: 'tech stack', suggestion: 'add an infra bullet here' },
      ],
    }) as never);
    const r = await s.synthesize({ rollup, resume });
    expect(r?.reconciliation.unsupportedClaims.map(c => c.claim)).toEqual(['Kept grounded claim text']);
  });

  it('drops an undersold item whose rollupDimension is not a known rollup keyword', async () => {
    const s = new ReconciliationSynthesizer(gen({
      unsupportedClaims: [
        { claim: 'A grounded claim text', resumeRef: 'Acme', whyUnsupported: 'no domain evidence in the rollup' },
      ],
      undersold: [
        { evidence: 'Real grounded evidence', rollupDimension: 'tech stack', suggestion: 'suggestion one here' },
        { evidence: 'Phantom ungrounded evidence', rollupDimension: 'astrology', suggestion: 'suggestion two here' },
      ],
    }) as never);
    const r = await s.synthesize({ rollup, resume });
    expect(r?.reconciliation.undersold.map(u => u.evidence)).toEqual(['Real grounded evidence']);
  });

  it('returns a DEFINED result when one list is empty but the other is grounded (deliberate: not degraded)', async () => {
    const s = new ReconciliationSynthesizer(gen({
      unsupportedClaims: [
        { claim: 'Led a 12-person ML platform team', resumeRef: 'Acme', whyUnsupported: 'no ml domain in domain mix' },
      ],
      undersold: [
        { evidence: 'Ungrounded weak evidence', rollupDimension: 'vibes', suggestion: 'a suggestion here' },
      ],
    }) as never);
    const r = await s.synthesize({ rollup, resume });
    expect(r?.reconciliation.unsupportedClaims).toHaveLength(1);
    expect(r?.reconciliation.undersold).toEqual([]);
  });

  it('returns undefined when BOTH lists are empty after grounding (degraded, preserve prior)', async () => {
    const s = new ReconciliationSynthesizer(gen({
      unsupportedClaims: [{ claim: 'Ungrounded claim text', resumeRef: 'NopeCorp', whyUnsupported: 'a vague hunch only' }],
      undersold: [{ evidence: 'Ungrounded evidence text', rollupDimension: 'tarot', suggestion: 'a suggestion here' }],
    }) as never);
    await expect(s.synthesize({ rollup, resume })).resolves.toBeUndefined();
  });

  it('returns undefined when the résumé is empty (no claims to reconcile)', async () => {
    const s = new ReconciliationSynthesizer(gen({ unsupportedClaims: [], undersold: [] }) as never);
    const empty: ResumeForReconciliation = { skills: [], experience: [], projects: [] };
    await expect(s.synthesize({ rollup, resume: empty })).resolves.toBeUndefined();
  });

  it('returns undefined (never throws) on schema-invalid output', async () => {
    const s = new ReconciliationSynthesizer(gen({ unsupportedClaims: 'nope' }) as never);
    await expect(s.synthesize({ rollup, resume })).resolves.toBeUndefined();
  });

  it('returns undefined (never throws) when the generator throws', async () => {
    const s = new ReconciliationSynthesizer({ invoke: jest.fn(async () => { throw new Error('bedrock down'); }) } as never);
    await expect(s.synthesize({ rollup, resume })).resolves.toBeUndefined();
  });
});
