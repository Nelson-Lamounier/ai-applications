/** @format */
import { describe, it, expect } from '@jest/globals';
import type { Pool } from 'pg';
import { RdsProjectEvidenceRepository } from './project-evidence.js';

/** Minimal fake pg Pool returning canned rows keyed by a substring of the SQL. */
function fakePool(routes: Array<{ match: RegExp; rows: unknown[] }>) {
  return {
    query: async (sql: string) => {
      const r = routes.find(x => x.match.test(sql));
      return { rows: r ? r.rows : [] };
    },
  } as unknown as Pool;
}

describe('RdsProjectEvidenceRepository.load', () => {
  it('reads projects + case-study + repo evidence for a user into ProjectEvidenceInput', async () => {
    const pool = fakePool([
      { match: /FROM projects/i,            rows: [{ id: 'p1', name: 'AI Apps', tagline: 'Multi-agent platform', pitch: 'A platform.' }] },
      { match: /FROM project_components/i,  rows: [{ id: 'c1', project_id: 'p1', name: 'EKS', kind: 'infra' }] },
      { match: /FROM project_decisions/i,   rows: [{ id: 'd1', project_id: 'p1', title: 'Chose PG', decision: 'fit' }] },
      { match: /FROM project_stack_items/i, rows: [{ id: 's1', project_id: 'p1', name: 'Terraform', category: 'iac' }] },
      { match: /FROM project_tags/i,        rows: [{ project_id: 'p1', tag: 'observability' }] },
      { match: /technology_evidence/i,      rows: [{ project_id: 'p1', source: 'tech_evidence', id: 'e1', raw_name: 'pgvector', file_line: 'src/db.ts:12' }] },
    ]);
    const input = await new RdsProjectEvidenceRepository(pool).load('u1');
    expect(input.projects).toEqual([{ id: 'p1', name: 'AI Apps', tagline: 'Multi-agent platform', pitch: 'A platform.' }]);
    expect(input.components[0]).toEqual({ id: 'c1', projectId: 'p1', name: 'EKS', kind: 'infra' });
    expect(input.repoEvidence[0]).toEqual({ projectId: 'p1', source: 'tech_evidence', id: 'e1', rawName: 'pgvector', fileLine: 'src/db.ts:12' });
  });

  it('returns all-empty arrays when the user has no projects', async () => {
    const input = await new RdsProjectEvidenceRepository(fakePool([])).load('u1');
    expect(input).toEqual({ projects: [], components: [], decisions: [], stackItems: [], tags: [], repoEvidence: [] });
  });

  it('excludes ARCHIVED projects from the JD feed (a confirmed merge archives the repo defaults)', async () => {
    const seen: string[] = [];
    const pool = { query: async (sql: string) => { seen.push(sql); return { rows: [] }; } } as unknown as Pool;
    await new RdsProjectEvidenceRepository(pool).load('u1');
    const projectsSql = seen.find(s => /FROM projects\b/i.test(s));
    expect(projectsSql).toMatch(/status\s*<>\s*'archived'/i);
  });
});
