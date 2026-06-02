/** @format */
import type { Pool } from 'pg';
import type { StoryCandidate } from './story-mining-types.js';
import type { MineCommitInput, MinePullInput } from './story-mining.js';

/**
 * RLS-scoped persistence for the story-mining lane. Reads the already-ingested
 * repo_commits / repo_pull_requests (045) and upserts into story_candidates (064).
 * Mirrors RdsDsaEvidenceRepository: set_config('app.current_user_id') in a txn,
 * ROLLBACK on error, release in finally.
 */
export class RdsStoryCandidateRepository {
  constructor(private readonly pool: Pool) {}

  /** RLS-scoped SELECT of the user's commits for a repo (sha + message). */
  async readCommits(userId: string, repoFullName: string): Promise<MineCommitInput[]> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [userId]);
      const { rows } = await client.query(
        `SELECT sha, message FROM repo_commits
          WHERE user_id = $1::uuid AND repo_full_name = $2`,
        [userId, repoFullName],
      );
      await client.query('COMMIT');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return rows.map((r: any) => ({ sha: r.sha, message: r.message ?? '' }));
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /** RLS-scoped SELECT of the user's pull requests for a repo (number, body, state, html_url). */
  async readPulls(userId: string, repoFullName: string): Promise<MinePullInput[]> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [userId]);
      const { rows } = await client.query(
        `SELECT number, body, state, html_url FROM repo_pull_requests
          WHERE user_id = $1::uuid AND repo_full_name = $2`,
        [userId, repoFullName],
      );
      await client.query('COMMIT');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return rows.map((r: any) => ({
        number: r.number, body: r.body ?? '', state: r.state, htmlUrl: r.html_url,
      }));
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /** Upsert each candidate (idempotent on the PK). No-op on empty input. */
  async upsertMany(
    userId: string,
    repoFullName: string,
    candidates: readonly StoryCandidate[],
  ): Promise<void> {
    if (candidates.length === 0) return;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [userId]);
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
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /** RLS-scoped SELECT of all stored candidates for a repo. */
  async listForRepo(userId: string, repoFullName: string): Promise<StoryCandidate[]> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [userId]);
      const { rows } = await client.query(
        `SELECT story_type, anchor_key, anchors, confidence
           FROM story_candidates WHERE user_id = $1::uuid AND repo_full_name = $2
          ORDER BY story_type, anchor_key`,
        [userId, repoFullName],
      );
      await client.query('COMMIT');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return rows.map((r: any) => ({
        storyType: r.story_type, anchorKey: r.anchor_key,
        anchors: r.anchors, confidence: r.confidence,
      }));
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
}
