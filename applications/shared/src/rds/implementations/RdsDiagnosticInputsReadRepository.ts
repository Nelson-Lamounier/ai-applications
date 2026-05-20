/** @format */
import type { Pool } from 'pg';
import type {
  IDiagnosticInputsReadRepository, DiagnosticInputs,
  KbStats, ResumeEntryCounts,
} from '../interfaces/IDiagnosticInputsReadRepository.js';

export class RdsDiagnosticInputsReadRepository implements IDiagnosticInputsReadRepository {
  constructor(private readonly pool: Pool) {}

  async getDiagnosticInputs(userId: string): Promise<DiagnosticInputs> {
    // RLS wrapper copied verbatim from
    // RdsCareerHistoryReadRepository.getResumeForReconciliation.
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [userId]);

      // Query 1 — KB aggregates over the user's PROJECT-classified repos.
      // `repo_sync_state` has no `classification` column → JOIN
      // `repository_profiles` (migration 014; user_id UUID) for the
      // project-repo filter. `kb_quality_score` is NUMERIC(4,2) in 0..1;
      // KB_SCORE_THRESHOLD = 0.6 is documented in computeUserDiagnostic.
      // `repo_sync_state.user_id` is TEXT, so we cast it to UUID for the
      // JOIN and leave the WHERE on `s.user_id` uncast.
      const kbRow = (await client.query<{
        project_count: number | string;
        high_kb_count: number | string;
        avg_retrieval: number | string | null;
      }>(
        `SELECT
           count(*)                                            AS project_count,
           count(*) FILTER (WHERE s.kb_quality_score >= 0.6)   AS high_kb_count,
           AVG(s.retrieval_score)                              AS avg_retrieval
           FROM repo_sync_state    s
           JOIN repository_profiles p
             ON p.repo_full_name = s.repo_full_name
            AND p.user_id        = s.user_id::uuid
          WHERE s.user_id        = $1
            AND p.classification = 'project'`,
        [userId],
      )).rows[0];
      const kbStats: KbStats = {
        projectRepoCount:     Number(kbRow?.project_count ?? 0),
        reposWithHighKbScore: Number(kbRow?.high_kb_count ?? 0),
        avgRetrievalScore:    kbRow?.avg_retrieval == null ? null : Number(kbRow.avg_retrieval),
      };

      // Query 2 — résumé entry counts (singular entry_type per SP4-A3 finding).
      const resumeRows = (await client.query<{ entry_type: string; count: string }>(
        `SELECT entry_type, count(*) AS count
           FROM user_career_history
          WHERE user_id = $1::uuid
          GROUP BY entry_type`,
        [userId],
      )).rows;

      await client.query('COMMIT');

      let skills = 0, experience = 0, projects = 0;
      let resumePresent = false;
      for (const r of resumeRows) {
        resumePresent = true;
        const n = Number(r.count);
        if (r.entry_type === 'skill')           skills     = n;
        else if (r.entry_type === 'experience') experience = n;
        else if (r.entry_type === 'project')    projects   = n;
      }
      const resumeEntryCounts: ResumeEntryCounts = { skills, experience, projects };

      return { kbStats, resumePresent, resumeEntryCounts };
    } catch (err) {
      // Best-effort: do not shadow the original error if ROLLBACK fails.
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
}
