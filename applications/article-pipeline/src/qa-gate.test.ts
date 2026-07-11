/**
 * @format
 * QA gate decision logic — pass boundary, retry clamp, attempt capture.
 */
import {
  QA_RETRY_HARD_CAP,
  resolveMaxRetries,
  qaPassed,
  recordAttempt,
  buildRevisionNotes,
  articleStatusFor,
} from './qa-gate';
import type { QaValidationResult } from '@bedrock/shared';

const THRESHOLD = 80;

function qa(overrides: Partial<QaValidationResult> = {}): QaValidationResult {
  return {
    overallScore: 88,
    recommendation: 'publish',
    dimensions: {
      technicalAccuracy: { score: 90, issues: [] },
      contentQuality: {
        score: 60,
        issues: [{ severity: 'warning', location: 'intro', description: 'thin', fix: 'expand' }],
      },
    },
    summary: 'Solid, minor tweak.',
    confidenceOverride: 85,
    ...overrides,
  } as unknown as QaValidationResult;
}

describe('resolveMaxRetries (infinite-loop guard)', () => {
  it('defaults to the hard cap when unset', () => {
    expect(resolveMaxRetries(undefined)).toBe(QA_RETRY_HARD_CAP);
  });

  it('never exceeds the hard cap however large the config', () => {
    expect(resolveMaxRetries('999')).toBe(QA_RETRY_HARD_CAP);
    expect(resolveMaxRetries('3')).toBe(QA_RETRY_HARD_CAP);
  });

  it('allows lowering the budget', () => {
    expect(resolveMaxRetries('0')).toBe(0);
    expect(resolveMaxRetries('1')).toBe(1);
  });

  it('clamps negative and non-numeric to a safe bound', () => {
    expect(resolveMaxRetries('-5')).toBe(0);
    expect(resolveMaxRetries('nonsense')).toBe(QA_RETRY_HARD_CAP);
  });

  it('the hard cap is 2 — at most 3 generations total', () => {
    expect(QA_RETRY_HARD_CAP).toBe(2);
  });
});

describe('qaPassed', () => {
  it('passes on publish above threshold', () => {
    expect(qaPassed(qa({ recommendation: 'publish', overallScore: 80 }), THRESHOLD)).toBe(true);
  });

  it('fails when rejected regardless of score', () => {
    expect(qaPassed(qa({ recommendation: 'reject', overallScore: 95 }), THRESHOLD)).toBe(false);
  });

  it('fails below threshold regardless of recommendation', () => {
    expect(qaPassed(qa({ recommendation: 'publish', overallScore: 79 }), THRESHOLD)).toBe(false);
  });

  it('treats revise above threshold as a pass (human still reviews)', () => {
    expect(qaPassed(qa({ recommendation: 'revise', overallScore: 85 }), THRESHOLD)).toBe(true);
  });
});

describe('recordAttempt (durable failure capture)', () => {
  it('captures score, verdict, failed dimensions and flattened issues', () => {
    const rec = recordAttempt(1, qa({ recommendation: 'reject', overallScore: 55 }), THRESHOLD);
    expect(rec.attempt).toBe(1);
    expect(rec.overallScore).toBe(55);
    expect(rec.recommendation).toBe('reject');
    expect(rec.passed).toBe(false);
    expect(rec.failedDimensions).toEqual(['contentQuality']); // 60 < 80
    expect(rec.issues).toHaveLength(1);
    expect(rec.issues[0]).toMatchObject({ dimension: 'contentQuality', location: 'intro', fix: 'expand' });
  });
});

describe('buildRevisionNotes', () => {
  it('renders each issue as a dimension-tagged instruction, summary first', () => {
    const notes = buildRevisionNotes(qa());
    expect(notes[0]).toBe('QA summary: Solid, minor tweak.');
    expect(notes).toContain('[contentQuality/warning] intro: thin -> expand');
  });
});

describe('articleStatusFor', () => {
  it('maps pass to review and fail to flagged', () => {
    expect(articleStatusFor(true)).toBe('review');
    expect(articleStatusFor(false)).toBe('flagged');
  });
});
