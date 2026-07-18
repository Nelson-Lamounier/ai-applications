/** @format */
import type { Pool } from 'pg';

import { withUserRls } from '../rds/with-user-rls.js';
import type { StoryCandidate } from './story-mining-types.js';
import type { MineCommitInput, MinePullInput } from './story-mining.js';

/**
 * RLS-scoped persistence for the story-mining lane. Reads the already-ingested
 * repo_commits / repo_pull_requests (045) and upserts into story_candidates (064).
 * Every call runs through `withUserRls`, which demotes to `tucaken_app` and
 * stamps `app.current_user_id` in the same transaction. Mirrors
 * `RdsDsaEvidenceRepository`.
 */
export class RdsStoryCandidateRepository {
  constructor(private readonly pool: Pool) {}

  /** RLS-scoped SELECT of the user's commits for a repo (sha + message). */
  async readCommits(userId: string, repoFullName: string): Promise<MineCommitInput[]> {
    return withUserRls(this.pool, userId, async (client) => {
      const { rows } = await client.query(
        `SELECT sha, message FROM repo_commits
          WHERE user_id = $1::uuid AND repo_full_name = $2`,
        [userId, repoFullName],
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return rows.map((r: any) => ({ sha: r.sha, message: r.message ?? '' }));
    });
  }

  /** RLS-scoped SELECT of the user's pull requests for a repo (number, body, state, html_url). */
  async readPulls(userId: string, repoFullName: string): Promise<MinePullInput[]> {
    return withUserRls(this.pool, userId, async (client) => {
      const { rows } = await client.query(
        `SELECT number, body, state, html_url FROM repo_pull_requests
          WHERE user_id = $1::uuid AND repo_full_name = $2`,
        [userId, repoFullName],
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return rows.map((r: any) => ({
        number: r.number, body: r.body ?? '', state: r.state, htmlUrl: r.html_url,
      }));
    });
  }

  /** Upsert each candidate (idempotent on the PK). No-op on empty input. */
  async upsertMany(
    userId: string,
    repoFullName: string,
    candidates: readonly StoryCandidate[],
  ): Promise<void> {
    if (candidates.length === 0) return;
    await withUserRls(this.pool, userId, async (client) => {
      for (const c of candidates) {
        await client.query(
          `INSERT INTO story_candidates (
             user_id, repo_full_name, story_type, anchor_key, anchors, confidence
           ) VALUES ($1::uuid, $2, $3, $4, $5::jsonb, $6)
           ON CONFLICT (user_id, repo_full_name, story_type, anchor_key)
           DO UPDATE SET anchors = EXCLUDED.anchors, confidence = EXCLUDED.confidence`,
          [userId, repoFullName, c.storyType, c.anchorKey, JSON.stringify(c.anchors), c.confidence],
        );
      }
    });
  }

  /** RLS-scoped SELECT of all stored candidates for a repo. */
  async listForRepo(userId: string, repoFullName: string): Promise<StoryCandidate[]> {
    return withUserRls(this.pool, userId, async (client) => {
      const { rows } = await client.query(
        `SELECT story_type, anchor_key, anchors, confidence
           FROM story_candidates WHERE user_id = $1::uuid AND repo_full_name = $2
          ORDER BY story_type, anchor_key`,
        [userId, repoFullName],
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return rows.map((r: any) => ({
        storyType: r.story_type, anchorKey: r.anchor_key,
        anchors: r.anchors, confidence: r.confidence,
      }));
    });
  }
}
