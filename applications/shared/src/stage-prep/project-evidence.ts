/** @format */
import type { Pool } from 'pg';
import type { ProjectEvidenceInput } from './skill-transfer-types.js';

/**
 * Reads a user's projects, curated case-study rows, and repo-derived evidence
 * (joined to projects via project_components → project_repositories → repositories →
 * {technology,dsa}_evidence.repo_full_name). RLS-scoped by user_id (queries also
 * filter user_id explicitly so an admin connection is safe).
 */
export class RdsProjectEvidenceRepository {
  constructor(private readonly pool: Pool) {}

  async load(userId: string): Promise<ProjectEvidenceInput> {
    const [projects, components, decisions, stackItems, tags, repoEvidence] = await Promise.all([
      this.pool.query(`SELECT id, name, tagline, pitch FROM projects WHERE user_id = $1`, [userId]),
      this.pool.query(`SELECT id, project_id, name, kind FROM project_components WHERE user_id = $1`, [userId]),
      this.pool.query(`SELECT id, project_id, title, decision FROM project_decisions WHERE user_id = $1`, [userId]),
      this.pool.query(`SELECT id, project_id, name, category FROM project_stack_items WHERE user_id = $1`, [userId]),
      this.pool.query(`SELECT project_id, tag FROM project_tags WHERE user_id = $1`, [userId]),
      this.pool.query(
        `WITH proj_repo AS (
           SELECT DISTINCT pc.project_id, r.full_name
             FROM project_repositories pr
             JOIN project_components pc ON pc.id = pr.project_component_id AND pc.user_id = $1
             JOIN repositories r        ON r.id = pr.repository_id
         )
         SELECT te.id::text AS id, pr.project_id, 'tech_evidence' AS source,
                te.raw_name, te.file_path || ':' || te.line_start AS file_line
           FROM technology_evidence te
           JOIN proj_repo pr ON pr.full_name = te.repo_full_name
          WHERE te.user_id = $1
         UNION ALL
         SELECT de.id::text AS id, pr.project_id, 'dsa_evidence' AS source,
                de.raw_name, de.file_path || ':' || de.line_start AS file_line
           FROM dsa_evidence de
           JOIN proj_repo pr ON pr.full_name = de.repo_full_name
          WHERE de.user_id = $1`,
        [userId],
      ),
    ]);
    return {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      projects:   projects.rows.map((r: any) => ({ id: r.id, name: r.name, tagline: r.tagline ?? null, pitch: r.pitch ?? null })),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      components: components.rows.map((r: any) => ({ id: r.id, projectId: r.project_id, name: r.name, kind: r.kind })),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      decisions:  decisions.rows.map((r: any) => ({ id: r.id, projectId: r.project_id, title: r.title, decision: r.decision ?? null })),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stackItems: stackItems.rows.map((r: any) => ({ id: r.id, projectId: r.project_id, name: r.name, category: r.category })),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tags:       tags.rows.map((r: any) => ({ projectId: r.project_id, tag: r.tag })),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      repoEvidence: repoEvidence.rows.map((r: any) => ({ projectId: r.project_id, source: r.source, id: r.id, rawName: r.raw_name, fileLine: r.file_line })),
    };
  }
}
