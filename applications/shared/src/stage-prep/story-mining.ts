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
/**
 * A quantified PERFORMANCE/COST metric. Every alternative carries a unit — a bare
 * `N->M` (version bumps like "Node 18->20") or a trivial `$1`/`$5` must NOT match
 * (they are necessary-not-sufficient noise, not measured improvements). A unit-bearing
 * before→after (e.g. `120ms→40ms`) already matches via the unit alternative on `120ms`.
 */
const METRIC = new RegExp([
  '\\d+(\\.\\d+)?\\s?(%|ms|x|×)',                 // 37% / 120ms / 3x
  '\\d+(\\.\\d+)?\\s?s\\b',                        // 1.2s (word-bounded so it isn't any trailing 's')
  '\\$\\s?\\d{1,3}(,\\d{3})+',                     // $1,200
  '\\$\\s?\\d{4,}',                                // $5000
  '\\$\\s?\\d+(\\.\\d+)?\\s?[kKmM]\\b',            // $5k / $1.5M
  '\\$\\s?\\d+(\\.\\d+)?\\s?/\\s?(mo|month|yr|year)', // $200/mo
].join('|'));

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
