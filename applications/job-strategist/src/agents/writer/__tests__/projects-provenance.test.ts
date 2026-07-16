/** @format */
import { describe, it, expect } from '@jest/globals';
import {
  validateProjectsProvenance, assembleProjects, ProjectsProvenanceError, PROJECTS_MAX_BULLETS_PER_ENTRY,
} from '../projects-provenance.js';
import { normaliseProjectsAgentOutput, ProjectsAgentOutputSchema, type ProjectsAgentOutput } from '../projects-schema.js';
import type { ProjectPoolEntry } from '../../evidence/project-agent-inputs.js';

const pool: ProjectPoolEntry[] = [
  {
    index: 0,
    name: 'Tucaken',
    pitch: 'career platform helping engineers land jobs faster through evidence grounded coaching',
    repoUrls: ['github.com/o/tucaken-app'],
    curated: [
      { id: 'p0.b0', text: 'Built the onboarding flow end to end' },
      { id: 'p0.b1', text: 'Wrote the RLS policies for multi-tenant data' },
      { id: 'p0.b2', text: 'Shipped the coach phone-screen agent' },
    ],
    repoCurrent: [
      { id: 'p0.r0', skill: 'PostgreSQL', sourceCitation: 'src/db/rls.ts', repositoryId: 'r1', githubRepoId: 1, fullName: 'o/tucaken-app' },
      { id: 'p0.r1', skill: 'Kubernetes', sourceCitation: 'infra/k8s.yaml', repositoryId: 'r1', githubRepoId: 1, fullName: 'o/tucaken-app' },
      { id: 'p0.r2', skill: 'TypeScript', sourceCitation: 'src/index.ts', repositoryId: 'r1', githubRepoId: 1, fullName: 'o/tucaken-app' },
    ],
  },
  {
    index: 1,
    name: 'Portfolio',
    pitch: 'personal engineering portfolio showcasing production-grade infrastructure and AI pipelines',
    repoUrls: ['github.com/o/portfolio'],
    curated: [{ id: 'p1.b0', text: 'Automated CI checks across every workspace' }],
    repoCurrent: [{ id: 'p1.r0', skill: 'Terraform', sourceCitation: 'infra/main.tf', repositoryId: 'r2', githubRepoId: 2, fullName: 'o/portfolio' }],
  },
];

const good: ProjectsAgentOutput = {
  entries: [
    {
      name: 'Tucaken',
      github: 'github.com/o/tucaken-app',
      description: 'Tucaken is a career platform helping engineers land jobs faster with grounded evidence and Postgres-backed coaching workflows.',
      highlights: [
        { bulletId: 'p0.b0' },
        { bulletId: 'p0.b1' },
        { text: 'Instrumented Postgres row-level security checks across every write path', sources: ['p0.r0'] },
      ],
    },
    {
      name: 'Portfolio',
      github: 'github.com/o/portfolio',
      description: 'Portfolio is a personal engineering showcase demonstrating production infrastructure and AI pipelines work.',
      highlights: [
        { bulletId: 'p1.b0' },
        { text: 'Provisioned Terraform-managed infrastructure for every environment', sources: ['p1.r0'] },
      ],
    },
  ],
};

describe('validateProjectsProvenance', () => {
  it('accepts a fully-cited, well-formed output', () => {
    expect(validateProjectsProvenance(good, pool)).toEqual([]);
  });

  it('rejects an entry naming a project outside the pool', () => {
    const bad = structuredClone(good);
    bad.entries[0]!.name = 'NotAProject';
    expect(validateProjectsProvenance(bad, pool)).toContain('unknown_project:NotAProject');
  });

  it('rejects the same project emitted twice', () => {
    const bad = structuredClone(good);
    bad.entries.push(structuredClone(bad.entries[0]!));
    expect(validateProjectsProvenance(bad, pool)).toContain('duplicate_project:Tucaken');
  });

  it('rejects a documented project with a non-empty curated pool missing from the output', () => {
    const bad = structuredClone(good);
    bad.entries = [bad.entries[0]!];
    expect(validateProjectsProvenance(bad, pool)).toContain('missing_project:Portfolio');
  });

  it('rejects a curated bulletId that exists nowhere in the pool', () => {
    const bad = structuredClone(good);
    bad.entries[0]!.highlights[0] = { bulletId: 'p0.b99' };
    expect(validateProjectsProvenance(bad, pool)).toContain('unknown_bullet:Tucaken:p0.b99');
  });

  it('rejects the same curated bulletId cited twice within one project', () => {
    const bad = structuredClone(good);
    bad.entries[0]!.highlights[1] = { bulletId: 'p0.b0' };
    expect(validateProjectsProvenance(bad, pool)).toContain('duplicate_bullet:Tucaken:p0.b0');
  });

  it('rejects a curated id that belongs to another project\'s pool', () => {
    const bad = structuredClone(good);
    bad.entries[0]!.highlights[0] = { bulletId: 'p1.b0' };
    expect(validateProjectsProvenance(bad, pool)).toContain('cross_project_citation:Tucaken:p1.b0');
  });

  it('rejects a composed highlight whose sources all fail to resolve', () => {
    const bad = structuredClone(good);
    bad.entries[0]!.highlights[2] = { text: 'Instrumented Postgres row-level security checks across every write path', sources: ['p0.zzz'] };
    expect(validateProjectsProvenance(bad, pool)).toContain('uncited_composed:Tucaken:2');
  });

  it('rejects a bullet count below min(3, poolSize)', () => {
    const bad = structuredClone(good);
    bad.entries[0]!.highlights = [bad.entries[0]!.highlights[0]!];
    expect(validateProjectsProvenance(bad, pool)).toContain('bullet_count:Tucaken:1');
  });

  it('rejects a github value not in the project\'s repoUrls', () => {
    const bad = structuredClone(good);
    bad.entries[0]!.github = 'github.com/o/other-repo';
    expect(validateProjectsProvenance(bad, pool)).toContain('github_mismatch:Tucaken');
  });

  // REGRESSION (cross-task seam, T1 x this validator): the normaliser blanks
  // every agent-emitted description to '' BEFORE this validator runs
  // (run-pipeline validates the parsed output, then stamps descriptions).
  // The retired pitch_overlap rule fired on that blanked echo for EVERY
  // entry on EVERY run, so the agent lane could never pass validation and
  // always fell back. Descriptions are system-authored (stamped from the
  // stored pitch after validation) -- a blanked description with valid
  // highlights MUST validate clean.
  it('accepts a normalised output (all descriptions blanked to "") when highlights are valid', () => {
    const raw = {
      entries: good.entries.map((e) => ({ ...e, description: 'a model-authored pitch the normaliser discards' })),
    };
    const { output, normalisedExtras } = normaliseProjectsAgentOutput(raw);
    expect(normalisedExtras).toBe(2);
    const parsed = ProjectsAgentOutputSchema.parse(output);
    expect(parsed.entries.every((e) => e.description === '')).toBe(true);
    expect(validateProjectsProvenance(parsed, pool)).toEqual([]);
  });
});

// Task 3: the composed cap is lifted to PROJECTS_MAX_BULLETS_PER_ENTRY (the SAME
// cap as bullet_count) -- curated and composed bullets now compete for slots
// purely on JD relevance, not a separate low composed-only allowance.
describe('composed cap lifted to the per-entry bullet cap (Task 3)', () => {
  const description = 'Tucaken is a career platform helping engineers land jobs faster with grounded evidence coaching.';
  const capPool: ProjectPoolEntry[] = [
    {
      index: 0,
      name: 'Tucaken',
      pitch: 'career platform helping engineers land jobs faster through evidence grounded coaching',
      repoUrls: ['github.com/o/tucaken-app'],
      curated: [],
      repoCurrent: Array.from({ length: PROJECTS_MAX_BULLETS_PER_ENTRY + 1 }, (_, i) => ({
        id: `p0.r${i}`, skill: `Skill${i}`, sourceCitation: `src/file${i}.ts`,
        repositoryId: 'r1', githubRepoId: 1, fullName: 'o/tucaken-app',
      })),
    },
  ];

  it(`validates an entry with exactly ${PROJECTS_MAX_BULLETS_PER_ENTRY} composed highlights, all sourced to the same project's own facts`, () => {
    const out: ProjectsAgentOutput = {
      entries: [{
        name: 'Tucaken', github: 'github.com/o/tucaken-app', description,
        highlights: Array.from({ length: PROJECTS_MAX_BULLETS_PER_ENTRY }, (_, i) => (
          { text: `Composed bullet number ${i} grounded in repo-current evidence`, sources: [`p0.r${i}`] }
        )),
      }],
    };
    expect(validateProjectsProvenance(out, capPool)).toEqual([]);
  });

  it(`rejects an entry one bullet over the cap (${PROJECTS_MAX_BULLETS_PER_ENTRY + 1}) via BOTH bullet_count and the `
    + 'now-equal composed_cap guard -- composedCount can never exceed highlights.length, so the two always co-fire '
    + 'once the caps match', () => {
    const out: ProjectsAgentOutput = {
      entries: [{
        name: 'Tucaken', github: 'github.com/o/tucaken-app', description,
        highlights: Array.from({ length: PROJECTS_MAX_BULLETS_PER_ENTRY + 1 }, (_, i) => (
          { text: `Composed bullet number ${i} grounded in repo-current evidence`, sources: [`p0.r${i}`] }
        )),
      }],
    };
    const violations = validateProjectsProvenance(out, capPool);
    expect(violations).toContain(`bullet_count:Tucaken:${PROJECTS_MAX_BULLETS_PER_ENTRY + 1}`);
    expect(violations).toContain(`composed_cap:Tucaken:${PROJECTS_MAX_BULLETS_PER_ENTRY + 1}`);
  });
});

describe('ProjectsProvenanceError', () => {
  it('carries its violations array', () => {
    expect(new ProjectsProvenanceError(['unknown_project:X']).violations).toEqual(['unknown_project:X']);
  });
});

describe('assembleProjects', () => {
  it('resolves curated ids to pool text verbatim, keeps composed text, and preserves order', () => {
    const assembled = assembleProjects(good, pool);
    expect(assembled).toEqual([
      {
        name: 'Tucaken',
        description: good.entries[0]!.description,
        github: 'github.com/o/tucaken-app',
        highlights: [
          'Built the onboarding flow end to end',
          'Wrote the RLS policies for multi-tenant data',
          'Instrumented Postgres row-level security checks across every write path',
        ],
      },
      {
        name: 'Portfolio',
        description: good.entries[1]!.description,
        github: 'github.com/o/portfolio',
        highlights: [
          'Automated CI checks across every workspace',
          'Provisioned Terraform-managed infrastructure for every environment',
        ],
      },
    ]);
  });

  it('falls back to the project\'s first repoUrl when the emitted github is not one of its own', () => {
    const bad = structuredClone(good);
    bad.entries[0]!.github = 'github.com/o/other-repo';
    const assembled = assembleProjects(bad, pool);
    expect(assembled[0]!.github).toBe('github.com/o/tucaken-app');
  });
});
