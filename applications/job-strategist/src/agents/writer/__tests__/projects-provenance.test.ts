/** @format */
import { describe, it, expect } from '@jest/globals';
import { validateProjectsProvenance, assembleProjects, ProjectsProvenanceError } from '../projects-provenance.js';
import type { ProjectsAgentOutput } from '../projects-schema.js';
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

  it('rejects more than two composed highlights for one project', () => {
    const bad = structuredClone(good);
    bad.entries[0]!.highlights.push(
      { text: 'Hardened cluster networking policies', sources: ['p0.r1'] },
      { text: 'Instrumented CI type-checking across every package', sources: ['p0.r2'] },
    );
    expect(validateProjectsProvenance(bad, pool)).toContain('composed_cap:Tucaken:3');
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

  it('rejects a description over 40 words', () => {
    const bad = structuredClone(good);
    bad.entries[0]!.description = `${bad.entries[0]!.description} ${Array.from({ length: 40 }, () => 'filler').join(' ')}`;
    expect(validateProjectsProvenance(bad, pool)).toContain('description_words:Tucaken:57');
  });

  it('rejects a description with under 30% distinctive-token overlap with the pitch', () => {
    const bad = structuredClone(good);
    bad.entries[0]!.description = 'Wrote generic prose unrelated to any earlier concept described previously somewhere else.';
    expect(validateProjectsProvenance(bad, pool)).toContain('pitch_overlap:Tucaken');
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
