/** @format */
import type { Pool } from 'pg';
import type { StoryCandidate } from './story-mining-types.js';
import { RdsStoryCandidateRepository } from './story-mining-persistence.js';

/** Git's auto-generated revert subject line. */
const REVERT_SUBJECT = /^Revert "(.+)"/m;
/** Git's auto-generated "This reverts commit <sha>" body line. */
const REVERTS_COMMIT = /This reverts commit ([0-9a-f]{7,40})/;
/** A GitHub structured issue close — close/fix/resolve (+s/d) #N. */
const STRUCTURED_CLOSE = /(close|fix|resolve)(s|d)?\s+#(\d+)/i;
/** A quantified metric — percentage / duration / multiplier / before→after / dollar figure. */
const METRIC = /(\d+(\.\d+)?\s?(%|ms|s|x|×)|\d+\s?(→|->)\s?\d+|\$\s?\d[\d,]*)/;

export interface MineCommitInput {
  readonly sha: string;
  readonly message: string;
}

export interface MinePullInput {
  readonly number: number;
  readonly body: string;
  readonly state: string;
  readonly htmlUrl: string;
}

/**
 * Pure, deterministic two-artifact story detector. NO LLM, NO keyword-only matches.
 * Single-signal matches (a bare "fix" message; `Closes #5` with no metric; a metric with
 * no issue link; a non-merged PR) emit NOTHING.
 */
export function mineStoryCandidates(
  commits: readonly MineCommitInput[],
  pulls: readonly MinePullInput[],
): StoryCandidate[] {
  const out: StoryCandidate[] = [];

  // ── incident: git revert (two linked commits, self-corroborating) ──
  for (const c of commits) {
    const subjectMatch = REVERT_SUBJECT.exec(c.message ?? '');
    const revertsMatch = REVERTS_COMMIT.exec(c.message ?? '');
    if (!subjectMatch || !revertsMatch) continue; // single signal → nothing
    out.push({
      storyType: 'incident',
      anchorKey: c.sha,
      anchors: {
        revertSha: c.sha,
        originalSha: revertsMatch[1],
        originalSubject: subjectMatch[1],
      },
      confidence: 0.85,
    });
  }

  // ── optimization: merged PR with a structured close AND a quantified metric ──
  for (const p of pulls) {
    if (p.state !== 'merged') continue; // non-merged → nothing
    const body = p.body ?? '';
    const closeMatch = STRUCTURED_CLOSE.exec(body);
    const metricMatch = METRIC.exec(body);
    if (!closeMatch || !metricMatch) continue; // single signal → nothing
    out.push({
      storyType: 'optimization',
      anchorKey: `pr-${p.number}`,
      anchors: {
        prNumber: p.number,
        issueRef: `#${closeMatch[3]}`,
        metric: metricMatch[0],
        htmlUrl: p.htmlUrl,
      },
      confidence: 0.7,
    });
  }

  return out;
}

/**
 * Read the user's already-ingested commits + PRs (RLS-scoped), mine two-artifact story
 * candidates, and upsert them. Returns the number of candidates persisted.
 */
export async function runStoryMining(
  pool: Pool,
  userId: string,
  repoFullName: string,
): Promise<number> {
  const repo = new RdsStoryCandidateRepository(pool);
  const [commits, pulls] = await Promise.all([
    repo.readCommits(userId, repoFullName),
    repo.readPulls(userId, repoFullName),
  ]);
  const candidates = mineStoryCandidates(commits, pulls);
  await repo.upsertMany(userId, repoFullName, candidates);
  return candidates.length;
}
