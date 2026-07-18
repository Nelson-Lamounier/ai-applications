/** @format */
import type { Pool } from 'pg';

import { withUserRls } from '../rds/with-user-rls.js';

export class DsaTopicResolver {
  constructor(private readonly valid: ReadonlySet<string>) {}
  /** @returns the canonical name if seeded in dsa_topics, else null (never invents). */
  resolve(topicHint: string): string | null { return this.valid.has(topicHint) ? topicHint : null; }
}

export interface DsaEvidenceRow {
  readonly repoFullName: string; readonly commitSha: string; readonly dsaTopic: string;
  readonly signal: string; readonly rawName: string; readonly filePath: string;
  readonly lineStart: number; readonly confidence: number;
}

export class RdsDsaEvidenceRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * Commit-SHA short-circuit for the DSA lane — independent of technology_evidence.
   * Backed by the dsa_scanned_commits MARKER (not dsa_evidence rows): a repo with zero
   * DSA patterns is still "scanned", so it is NOT re-downloaded + re-scanned on every
   * re-sync. Lets an already-tech-scanned commit still get a one-time DSA backfill.
   */
  async hasDsaScanForCommit(userId: string, repoFullName: string, commitSha: string): Promise<boolean> {
    return withUserRls(this.pool, userId, async (client) => {
      const { rows } = await client.query(
        `SELECT 1 FROM dsa_scanned_commits
          WHERE user_id = $1::uuid AND repo_full_name = $2 AND commit_sha = $3
          LIMIT 1`,
        [userId, repoFullName, commitSha],
      );
      return rows.length > 0;
    });
  }

  /** Records that the DSA pass completed for a commit (idempotent), with the match count. */
  async recordDsaScan(userId: string, repoFullName: string, commitSha: string, matchCount: number): Promise<void> {
    await withUserRls(this.pool, userId, async (client) => {
      await client.query(
        `INSERT INTO dsa_scanned_commits (user_id, repo_full_name, commit_sha, match_count)
         VALUES ($1::uuid, $2, $3, $4)
         ON CONFLICT (user_id, repo_full_name, commit_sha)
         DO UPDATE SET match_count = EXCLUDED.match_count, scanned_at = now()`,
        [userId, repoFullName, commitSha, matchCount],
      );
    });
  }

  async insertMany(userId: string, rows: DsaEvidenceRow[]): Promise<void> {
    if (rows.length === 0) return;
    await withUserRls(this.pool, userId, async (client) => {
      for (const r of rows) {
        await client.query(
          `INSERT INTO dsa_evidence (
             user_id, repo_full_name, commit_sha, dsa_topic, signal, raw_name, file_path, line_start, confidence
           ) VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT DO NOTHING`,
          [userId, r.repoFullName, r.commitSha, r.dsaTopic, r.signal, r.rawName, r.filePath, r.lineStart, r.confidence],
        );
      }
    });
  }

  async listForRepo(userId: string, repoFullName: string): Promise<DsaEvidenceRow[]> {
    return withUserRls(this.pool, userId, async (client) => {
      const { rows } = await client.query(
        `SELECT repo_full_name, commit_sha, dsa_topic, signal, raw_name, file_path, line_start, confidence
           FROM dsa_evidence WHERE user_id=$1::uuid AND repo_full_name=$2
          ORDER BY dsa_topic, file_path, line_start`, [userId, repoFullName]);
      return rows.map((r: any) => ({ repoFullName: r.repo_full_name, commitSha: r.commit_sha,
        dsaTopic: r.dsa_topic, signal: r.signal, rawName: r.raw_name, filePath: r.file_path,
        lineStart: r.line_start, confidence: r.confidence }));
    });
  }
}
