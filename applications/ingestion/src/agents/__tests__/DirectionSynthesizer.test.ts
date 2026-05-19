import { DirectionSynthesizer } from '../DirectionSynthesizer.js';
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

describe('DirectionSynthesizer.synthesize', () => {
  it('returns direction on a valid grounded tool result', async () => {
    const s = new DirectionSynthesizer(gen({
      archetypes: [
        { archetype: 'platform', fit: 'strong', rationale: 'infra domain mix dominant + AWS tech stack' },
        { archetype: 'backend',  fit: 'moderate', rationale: 'TypeScript language share, fewer app repos' },
        { archetype: 'ml',       fit: 'weak', rationale: 'no ml domain in domain mix' },
      ],
      seniority: [{ area: 'infrastructure', level: 'senior', evidence: 'complexity distribution + 2 active years' }],
      whatToDeepen: ['Surface incident-response evidence in repos.'],
    }) as never);
    const r = await s.synthesize(rollup);
    expect(r?.direction.archetypes).toHaveLength(3);
    expect(r?.direction.archetypes[0]).toMatchObject({ archetype: 'platform', fit: 'strong' });
    expect(r?.direction.seniority[0].level).toBe('senior');
    expect(r?.direction.whatToDeepen).toHaveLength(1);
  });

  it('drops archetypes whose rationale references no rollup dimension', async () => {
    const s = new DirectionSynthesizer(gen({
      archetypes: [
        { archetype: 'platform', fit: 'strong', rationale: 'grounded in domain mix (infra)' },
        { archetype: 'cloud',    fit: 'moderate', rationale: 'general industry vibe, trust me' },
        { archetype: 'ml',       fit: 'weak', rationale: 'pure speculation, no basis' },
      ],
      seniority: [{ area: 'infra', level: 'mid-senior', evidence: 'role distribution creator-heavy' }],
      whatToDeepen: [],
    }) as never);
    const r = await s.synthesize(rollup);
    expect(r?.direction.archetypes.map(a => a.archetype)).toEqual(['platform']);
  });

  it('returns undefined when ALL archetypes are ungrounded (degraded, do not overwrite prior)', async () => {
    const s = new DirectionSynthesizer(gen({
      archetypes: [
        { archetype: 'platform', fit: 'strong', rationale: 'a hunch about you' },
        { archetype: 'backend',  fit: 'weak', rationale: 'gut feeling only' },
        { archetype: 'ml',       fit: 'weak', rationale: 'pure vibes here' },
      ],
      seniority: [{ area: 'x', level: 'mid', evidence: 'role distribution' }],
      whatToDeepen: ['something here that is long enough'],
    }) as never);
    await expect(s.synthesize(rollup)).resolves.toBeUndefined();
  });

  it('returns undefined (never throws) on schema-invalid output', async () => {
    const s = new DirectionSynthesizer(gen({ archetypes: [] }) as never);
    await expect(s.synthesize(rollup)).resolves.toBeUndefined();
  });

  it('returns undefined (never throws) when the generator throws', async () => {
    const s = new DirectionSynthesizer({ invoke: jest.fn(async () => { throw new Error('bedrock down'); }) } as never);
    await expect(s.synthesize(rollup)).resolves.toBeUndefined();
  });
});
