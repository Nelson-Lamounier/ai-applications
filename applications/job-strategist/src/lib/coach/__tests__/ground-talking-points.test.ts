import { describe, it, expect } from '@jest/globals';
import { groundTalkingPoints } from '../ground-talking-points.js';

describe('groundTalkingPoints', () => {
  const verified = ['AWS', 'CDK', 'Kubernetes'];

  it('keeps only matchedSkills that are verified', () => {
    const out = groundTalkingPoints(
      [{ point: 'Owns AWS delivery', evidence: 'pipeline', matchedSkills: ['AWS', 'Rust'] }],
      verified,
    );
    expect(out).toHaveLength(1);
    expect(out[0].matchedSkills).toEqual(['AWS']);
  });

  it('drops a talking point whose skills are all unverified', () => {
    const out = groundTalkingPoints(
      [{ point: 'Knows Rust', evidence: 'x', matchedSkills: ['Rust'] }],
      verified,
    );
    expect(out).toHaveLength(0);
  });

  it('passes through points with no matchedSkills (legacy)', () => {
    const out = groundTalkingPoints(
      [{ point: 'General fit', evidence: 'x', matchedSkills: [] }],
      verified,
    );
    expect(out).toHaveLength(1);
  });

  it('matches case-insensitively', () => {
    const out = groundTalkingPoints(
      [{ point: 'p', evidence: 'e', matchedSkills: ['aws'] }],
      verified,
    );
    expect(out[0].matchedSkills).toEqual(['aws']);
  });
});
