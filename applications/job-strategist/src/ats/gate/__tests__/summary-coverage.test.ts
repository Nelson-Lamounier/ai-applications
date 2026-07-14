/** @format */
import { describe, it, expect } from '@jest/globals';
import { scoreSummaryCoverage } from '../summary-coverage.js';
const t = (skill: string) => ({ skill, source: 'hard' as const, verdict: 'verified' as const });

describe('scoreSummaryCoverage', () => {
  it('counts a target present as a whole word/phrase', () => {
    const r = scoreSummaryCoverage('Backend engineer who ships on Kubernetes and AWS.', [t('Kubernetes'), t('AWS'), t('Terraform')]);
    expect(r).toEqual({ targets: 3, covered: 2, missing: ['Terraform'] });
  });
  it('does NOT false-positive on a substring/generic token', () => {
    // "Go" must not match "ongoing"; multi-word must not match across unrelated words
    const r = scoreSummaryCoverage('Made ongoing decisions about project timelines and stakeholder management.', [t('Go'), t('project management')]);
    expect(r.covered).toBe(0);
  });
  it('requires the literal adjacent phrase for multi-word targets (stricter than the body gate proximity)', () => {
    // adjacent phrase -> covered; tokens merely co-occurring in a sentence -> NOT covered
    expect(scoreSummaryCoverage('Led project management for the platform.', [t('project management')]).covered).toBe(1);
    expect(scoreSummaryCoverage('Owned the project timeline and reported to management weekly.', [t('project management')]).covered).toBe(0);
  });
});
