/** @format */
import type { Pool } from 'pg';

export class DsaTopicResolver {
  constructor(private readonly valid: ReadonlySet<string>) {}
  /** @returns the canonical name if seeded in dsa_topics, else null (never invents). */
  resolve(topicHint: string): string | null { return this.valid.has(topicHint) ? topicHint : null; }
}

export interface DsaEvidenceRow {
  readonly repoFullName: string; readonly commitSha: string; readonly dsaTopic: string;
  readonly signal: string; readonly rawName: string; readonly filePath: string;
  readonly lineStart: number | null; readonly confidence: number;
}

export class RdsDsaEvidenceRepository {
  constructor(private readonly pool: Pool) {}

  async insertMany(userId: string, rows: DsaEvidenceRow[]): Promise<void> {
    if (rows.length === 0) return;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [userId]);
      for (const r of rows) {
        await client.query(
          `INSERT INTO dsa_evidence (
             user_id, repo_full_name, commit_sha, dsa_topic, signal, raw_name, file_path, line_start, confidence
           ) VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT DO NOTHING`,
          [userId, r.repoFullName, r.commitSha, r.dsaTopic, r.signal, r.rawName, r.filePath, r.lineStart, r.confidence],
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

  async listForRepo(userId: string, repoFullName: string): Promise<DsaEvidenceRow[]> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [userId]);
      const { rows } = await client.query(
        `SELECT repo_full_name, commit_sha, dsa_topic, signal, raw_name, file_path, line_start, confidence
           FROM dsa_evidence WHERE user_id=$1::uuid AND repo_full_name=$2
          ORDER BY dsa_topic, file_path, line_start`, [userId, repoFullName]);
      await client.query('COMMIT');
      return rows.map((r: any) => ({ repoFullName: r.repo_full_name, commitSha: r.commit_sha,
        dsaTopic: r.dsa_topic, signal: r.signal, rawName: r.raw_name, filePath: r.file_path,
        lineStart: r.line_start, confidence: r.confidence }));
    } catch (err) { await client.query('ROLLBACK').catch(() => {}); throw err; }
    finally { client.release(); }
  }
}
