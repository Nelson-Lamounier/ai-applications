/** @format */
import type { Pool } from 'pg';

import { withUserRls } from '../rds/with-user-rls.js';

export class AiTopicResolver {
  constructor(private readonly valid: ReadonlySet<string>) {}
  /** @returns the canonical name if seeded in ai_topics, else null (never invents). */
  resolve(topicHint: string): string | null { return this.valid.has(topicHint) ? topicHint : null; }
}

export interface AiEvidenceRow {
  readonly repoFullName: string; readonly commitSha: string; readonly aiTopic: string;
  readonly signal: string; readonly rawName: string; readonly filePath: string;
  readonly lineStart: number; readonly confidence: number;
}

export class RdsAiEvidenceRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * Commit-SHA short-circuit for the AI lane — independent of technology_evidence.
   * Backed by the ai_scanned_commits MARKER (not ai_evidence rows): a repo with zero
   * AI patterns is still "scanned", so it is NOT re-downloaded + re-scanned on every
   * re-sync. Lets an already-tech-scanned commit still get a one-time AI backfill.
   */
  async hasAiScanForCommit(userId: string, repoFullName: string, commitSha: string): Promise<boolean> {
    return withUserRls(this.pool, userId, async (client) => {
      const { rows } = await client.query(
        `SELECT 1 FROM ai_scanned_commits
          WHERE user_id = $1::uuid AND repo_full_name = $2 AND commit_sha = $3
          LIMIT 1`,
        [userId, repoFullName, commitSha],
      );
      return rows.length > 0;
    });
  }

  /** Records that the AI pass completed for a commit (idempotent), with the match count. */
  async recordAiScan(userId: string, repoFullName: string, commitSha: string, matchCount: number): Promise<void> {
    await withUserRls(this.pool, userId, async (client) => {
      await client.query(
        `INSERT INTO ai_scanned_commits (user_id, repo_full_name, commit_sha, match_count)
         VALUES ($1::uuid, $2, $3, $4)
         ON CONFLICT (user_id, repo_full_name, commit_sha)
         DO UPDATE SET match_count = EXCLUDED.match_count, scanned_at = now()`,
        [userId, repoFullName, commitSha, matchCount],
      );
    });
  }

  async insertMany(userId: string, rows: AiEvidenceRow[]): Promise<void> {
    if (rows.length === 0) return;
    await withUserRls(this.pool, userId, async (client) => {
      for (const r of rows) {
        await client.query(
          `INSERT INTO ai_evidence (
             user_id, repo_full_name, commit_sha, ai_topic, signal, raw_name, file_path, line_start, confidence
           ) VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT DO NOTHING`,
          [userId, r.repoFullName, r.commitSha, r.aiTopic, r.signal, r.rawName, r.filePath, r.lineStart, r.confidence],
        );
      }
    });
  }

  async listForRepo(userId: string, repoFullName: string): Promise<AiEvidenceRow[]> {
    return withUserRls(this.pool, userId, async (client) => {
      const { rows } = await client.query(
        `SELECT repo_full_name, commit_sha, ai_topic, signal, raw_name, file_path, line_start, confidence
           FROM ai_evidence WHERE user_id=$1::uuid AND repo_full_name=$2
          ORDER BY ai_topic, file_path, line_start`, [userId, repoFullName]);
      return rows.map((r: any) => ({ repoFullName: r.repo_full_name, commitSha: r.commit_sha,
        aiTopic: r.ai_topic, signal: r.signal, rawName: r.raw_name, filePath: r.file_path,
        lineStart: r.line_start, confidence: r.confidence }));
    });
  }
}
