import { MirrorRevealSynthesizer } from '../MirrorRevealSynthesizer.js';
import type { UserProfileRollup } from '@bedrock/shared';

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

function gen(out: unknown) { return { invoke: jest.fn(async () => out) }; }

describe('MirrorRevealSynthesizer.synthesize', () => {
  it('returns mirror+reveal on a valid grounded tool result', async () => {
    const s = new MirrorRevealSynthesizer(gen({
      mirror: { paragraph: 'You are an infrastructure-focused engineer with deep AWS and IaC experience, operating mostly as a creator across infra projects over roughly two years of activity.' },
      reveals: [{ insight: 'You operate as a builder-creator, not a generalist contributor.', evidence: 'role distribution (creator 4 of 5)' }],
    }) as never);
    const r = await s.synthesize(rollup);
    expect(r?.mirror.paragraph).toMatch(/infrastructure/i);
    expect(r?.reveal.reveals).toHaveLength(1);
    expect(r?.reveal.reveals[0].evidence).toMatch(/role/i);
  });

  it('drops a reveal whose evidence does not reference a rollup dimension', async () => {
    const s = new MirrorRevealSynthesizer(gen({
      mirror: { paragraph: 'A'.repeat(130) },
      reveals: [
        { insight: 'Grounded one here, definitely.', evidence: 'domain mix (infra dominant)' },
        { insight: 'You code best at 2am, spooky.', evidence: 'your late-night vibe' },
      ],
    }) as never);
    const r = await s.synthesize(rollup);
    expect(r?.reveal.reveals.map(x => x.insight)).toEqual(['Grounded one here, definitely.']);
  });

  it('returns undefined (never throws) on schema-invalid output', async () => {
    const s = new MirrorRevealSynthesizer(gen({ mirror: { paragraph: 'too short' } }) as never);
    await expect(s.synthesize(rollup)).resolves.toBeUndefined();
  });

  it('returns undefined (never throws) when the generator throws', async () => {
    const s = new MirrorRevealSynthesizer({ invoke: jest.fn(async () => { throw new Error('bedrock down'); }) } as never);
    await expect(s.synthesize(rollup)).resolves.toBeUndefined();
  });
});
