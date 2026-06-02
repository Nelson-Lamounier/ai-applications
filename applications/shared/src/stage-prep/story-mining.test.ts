/** @format */
import { describe, it, expect } from '@jest/globals';
import { mineStoryCandidates } from './story-mining.js';

describe('mineStoryCandidates — incident (two-artifact: git revert)', () => {
  it('emits an incident from a git revert commit', () => {
    const commits = [
      {
        sha: 'aaaaaaa',
        message:
          'Revert "Add aggressive cache TTL"\n\nThis reverts commit 1234567abcdef0.\n',
      },
    ];
    const out = mineStoryCandidates(commits, []);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      storyType: 'incident',
      anchorKey: 'aaaaaaa',
      anchors: {
        revertSha: 'aaaaaaa',
        originalSha: '1234567abcdef0',
        originalSubject: 'Add aggressive cache TTL',
      },
      confidence: 0.85,
    });
  });

  it('NEGATIVE: a bare "fix bug" commit emits nothing (single signal)', () => {
    expect(mineStoryCandidates([{ sha: 'b', message: 'fix bug' }], [])).toEqual([]);
  });
});

describe('mineStoryCandidates — optimization (two-artifact: merged PR + metric)', () => {
  it('emits an optimization from a merged PR with a structured close and a metric', () => {
    const pulls = [
      {
        number: 42,
        body: 'Closes #12. Cut p95 latency by -37% under load.',
        state: 'merged',
        htmlUrl: 'https://github.com/o/r/pull/42',
      },
    ];
    const out = mineStoryCandidates([], pulls);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      storyType: 'optimization',
      anchorKey: 'pr-42',
      anchors: {
        prNumber: 42,
        issueRef: '#12',
        metric: '37%',
        htmlUrl: 'https://github.com/o/r/pull/42',
      },
      confidence: 0.7,
    });
  });

  it('NEGATIVE: merged PR "Closes #5" with no metric emits nothing', () => {
    const pulls = [
      { number: 5, body: 'Closes #5', state: 'merged', htmlUrl: 'https://github.com/o/r/pull/5' },
    ];
    expect(mineStoryCandidates([], pulls)).toEqual([]);
  });

  it('NEGATIVE: PR body with a metric "120ms→40ms" but no issue ref emits nothing', () => {
    const pulls = [
      {
        number: 7,
        body: 'Reduced render time 120ms→40ms.',
        state: 'merged',
        htmlUrl: 'https://github.com/o/r/pull/7',
      },
    ];
    expect(mineStoryCandidates([], pulls)).toEqual([]);
  });

  it('NEGATIVE: OPEN PR with both close and metric emits nothing (state !== merged)', () => {
    const pulls = [
      {
        number: 9,
        body: 'Closes #3. Saved 50% memory.',
        state: 'open',
        htmlUrl: 'https://github.com/o/r/pull/9',
      },
    ];
    expect(mineStoryCandidates([], pulls)).toEqual([]);
  });
});
