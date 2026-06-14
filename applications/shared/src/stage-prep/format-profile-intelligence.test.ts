/** @format */
import { describe, it, expect } from '@jest/globals';
import { formatProfileIntelligence, type ProfileIntelligenceInput } from './format-profile-intelligence.js';
import type { DirectionJson, ReconciliationJson } from '../rds/interfaces/IUserProfileRollupRepository.js';

const direction = (over: Partial<DirectionJson> = {}): DirectionJson => ({
  archetypes: [
    { archetype: 'platform', fit: 'strong', rationale: 'r' },
    { archetype: 'backend',  fit: 'moderate', rationale: 'r' },
    { archetype: 'ml',       fit: 'weak', rationale: 'r' },
  ],
  seniority: [
    { area: 'backend', level: 'senior', evidence: 'e' },
    { area: 'infrastructure', level: 'mid-senior', evidence: 'e' },
  ],
  whatToDeepen: ['observability depth'],
  ...over,
});

const recon = (over: Partial<ReconciliationJson> = {}): ReconciliationJson => ({
  unsupportedClaims: [{ claim: 'Led a team of 10', resumeRef: 'Acme Corp', whyUnsupported: 'no team signal in repos' }],
  undersold: [{ evidence: '47-migration RLS schema', rollupDimension: 'complexity', suggestion: 'add a data-platform bullet' }],
  ...over,
});

const EMPTY: ProfileIntelligenceInput = { direction: null, reconciliation: null };

describe('formatProfileIntelligence', () => {
  it('returns empty string when nothing is grounded', () => {
    expect(formatProfileIntelligence(EMPTY)).toBe('');
    expect(formatProfileIntelligence({ direction: null, reconciliation: { unsupportedClaims: [], undersold: [] } })).toBe('');
  });

  it('renders code-demonstrated direction, dropping weak archetypes and framing seniority as a separate signal', () => {
    const out = formatProfileIntelligence({ direction: direction(), reconciliation: null });
    expect(out).toMatch(/CANDIDATE PROFILE INTELLIGENCE/);
    expect(out).toMatch(/Strongest areas \(code-demonstrated\): platform \(strong\), backend \(moderate\)/);
    expect(out).not.toMatch(/\bml \(weak\)/);                 // weak dropped
    expect(out).toMatch(/Code-demonstrated seniority: backend — senior; infrastructure — mid-senior/);
    expect(out).toMatch(/weigh ALONGSIDE résumé-stated seniority/);
  });

  it('sorts archetypes strongest-fit first', () => {
    const out = formatProfileIntelligence({
      direction: direction({ archetypes: [
        { archetype: 'backend', fit: 'moderate', rationale: 'r' },
        { archetype: 'platform', fit: 'strong', rationale: 'r' },
      ] }),
      reconciliation: null,
    });
    expect(out.indexOf('platform (strong)')).toBeLessThan(out.indexOf('backend (moderate)'));
  });

  it('renders undersold strengths as surface-these', () => {
    const out = formatProfileIntelligence({ direction: null, reconciliation: recon() });
    expect(out).toMatch(/under-represents/);
    expect(out).toMatch(/- 47-migration RLS schema → add a data-platform bullet/);
  });

  it('renders unsupported claims as an anti-inflation guardrail', () => {
    const out = formatProfileIntelligence({ direction: null, reconciliation: recon() });
    expect(out).toMatch(/do NOT present these as demonstrated production work/);
    expect(out).toMatch(/- Led a team of 10 \(résumé: Acme Corp\) — no team signal/);
  });

  it('caps each section', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ archetype: `a${String(i)}`, fit: 'strong' as const, rationale: 'r' }));
    const out = formatProfileIntelligence(
      { direction: direction({ archetypes: many }), reconciliation: null },
      { maxArchetypes: 2 },
    );
    expect(out.match(/\(strong\)/g)?.length).toBe(2);
  });
});
