/** @format */
import type { Pool } from 'pg';
import type {
  ICareerHistoryReadRepository, ResumeForReconciliation,
  ResumeSkillGroup, ResumeExperienceEntry, ResumeProjectEntry,
} from '../interfaces/ICareerHistoryReadRepository.js';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

export class RdsCareerHistoryReadRepository implements ICareerHistoryReadRepository {
  constructor(private readonly pool: Pool) {}

  async getResumeForReconciliation(userId: string): Promise<ResumeForReconciliation | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [userId]);
      const { rows } = await client.query<{ entry_type: string; raw_data: unknown }>(
        `SELECT entry_type, raw_data
           FROM user_career_history
          WHERE user_id = $1::uuid
            AND entry_type IN ('skill','experience','project')
          ORDER BY display_order ASC`,
        [userId],
      );
      await client.query('COMMIT');
      if (rows.length === 0) return undefined;
      const skills: ResumeSkillGroup[] = [];
      const experience: ResumeExperienceEntry[] = [];
      const projects: ResumeProjectEntry[] = [];
      for (const row of rows) {
        const d = (row.raw_data ?? {}) as Record<string, unknown>;
        if (row.entry_type === 'skill') {
          skills.push({ category: str(d.category), skills: strArr(d.skills) });
        } else if (row.entry_type === 'experience') {
          experience.push({
            company: str(d.company),
            title: str(d.title),
            highlights: strArr(d.highlights),
          });
        } else if (row.entry_type === 'project') {
          projects.push({ name: str(d.name), description: str(d.description) });
        }
      }
      return { skills, experience, projects };
    } catch (err) {
      // Best-effort: do not shadow the original error if ROLLBACK fails.
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
}
