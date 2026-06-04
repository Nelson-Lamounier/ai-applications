/** @format */
import { describe, it, expect } from 'vitest';
import { validateSystemDesign } from '../validators.js';

const coverage = { detected: [{ concernId: 'rls', evidenceRefs: [{ id: 'c1' }] }], relevantTotal: 1, relevantAddressed: 1 };
const groundedCard = { concernId: 'rls', evidenceRefs: [{ id: 'c1' }], choiceMade: 'RLS' };
const base = { systemDesignCoverage: coverage, systemDesignWalkthrough: [groundedCard] };

describe('validateSystemDesign', () => {
  it('Tier A passes when coverage present', () => {
    expect(validateSystemDesign('A', base).ok).toBe(true);
  });
  it('Tier A fails when coverage missing', () => {
    expect(validateSystemDesign('A', { systemDesignWalkthrough: [] }).ok).toBe(false);
  });
  it('Tier B passes a grounded card', () => {
    expect(validateSystemDesign('B', base).ok).toBe(true);
  });
  it('Tier B fails an invented evidence id', () => {
    const bad = { ...base, systemDesignWalkthrough: [{ ...groundedCard, evidenceRefs: [{ id: 'FAKE' }] }] };
    const r = validateSystemDesign('B', bad);
    expect(r.ok).toBe(false);
    expect(r.failures.join()).toMatch(/FAKE/);
  });
  it('Tier B fails a gap card carrying evidence', () => {
    const bad = { ...base, systemDesignWalkthrough: [{ concernId: 'rls', choiceMade: null, evidenceRefs: [{ id: 'c1' }] }] };
    expect(validateSystemDesign('B', bad).ok).toBe(false);
  });
});
