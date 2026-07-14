/** @format */
import { describe, it, expect } from '@jest/globals';
import { resolveProjectsAts, joinProjectsText, deterministicProjects } from '../projects-ats-flow.js';
import type { ProjectsAgentOutput } from '../projects-schema.js';
import type { ProjectPoolEntry } from '../../evidence/project-agent-inputs.js';
import type { ExperienceAtsTarget } from '../../../ats/gate/experience-ats-targets.js';

const pool: ProjectPoolEntry[] = [
  {
    index: 0,
    name: 'Tucaken',
    pitch: 'career platform helping engineers land jobs faster through evidence grounded coaching',
    repoUrls: ['github.com/o/tucaken-app'],
    curated: [
      { id: 'p0.b0', text: 'Built the onboarding flow end to end' },
      { id: 'p0.b1', text: 'Wrote the RLS policies for multi-tenant Kubernetes clusters' },
      { id: 'p0.b2', text: 'Shipped the coach phone-screen agent' },
    ],
    repoCurrent: [
      { id: 'p0.r0', skill: 'DNS', sourceCitation: 'infra/dns.ts', repositoryId: 'r1', githubRepoId: 1, fullName: 'o/tucaken-app' },
    ],
  },
  {
    index: 1,
    name: 'Portfolio',
    pitch: 'personal engineering portfolio showcasing production-grade infrastructure and AI pipelines',
    repoUrls: ['github.com/o/portfolio'],
    curated: [{ id: 'p1.b0', text: 'Automated CI checks across every workspace' }],
    repoCurrent: [],
  },
];

const targets: ExperienceAtsTarget[] = [
  { skill: 'Kubernetes', source: 'hard', verdict: 'verified', requirement: 'Infra' },
  { skill: 'DNS', source: 'hard', verdict: 'verified', requirement: 'Networking' },
];

// covers Kubernetes only (1/2); Portfolio has no highlights emitted here on purpose --
// the PRECONDITION means resolveProjectsAts never re-validates `first`.
const first: ProjectsAgentOutput = {
  entries: [
    {
      name: 'Tucaken',
      github: 'github.com/o/tucaken-app',
      description: 'Tucaken is a career platform helping engineers land jobs faster with grounded evidence coaching.',
      highlights: [{ bulletId: 'p0.b0' }, { bulletId: 'p0.b1' }],
    },
  ],
};

// Portfolio has a non-empty curated pool -- validateProjectsProvenance's
// `missing_project` gate requires it to appear in any rewrite that gets validated.
const portfolioEntry = {
  name: 'Portfolio',
  github: 'github.com/o/portfolio',
  description: 'Portfolio is a personal engineering portfolio showcasing production-grade infrastructure and AI pipelines.',
  highlights: [{ bulletId: 'p1.b0' }],
};

// covers Kubernetes + DNS (2/2), provenance-valid (composed source p0.r0 is Tucaken's own)
const rewriteFull: ProjectsAgentOutput = {
  entries: [
    {
      name: 'Tucaken',
      github: 'github.com/o/tucaken-app',
      description: 'Tucaken is a career platform helping engineers land jobs faster with grounded evidence coaching.',
      highlights: [
        { bulletId: 'p0.b0' },
        { bulletId: 'p0.b1' },
        { text: 'Configured DNS resolution for Kubernetes ingress across every cluster', sources: ['p0.r0'] },
      ],
    },
    portfolioEntry,
  ],
};

describe('resolveProjectsAts', () => {
  it('does not fire a re-write when coverage is already full', async () => {
    let called = false;
    const r = await resolveProjectsAts({
      first: rewriteFull, pool, targets,
      rewrite: async () => { called = true; return rewriteFull; },
    });
    expect(called).toBe(false);
    expect(r.diag.rewrite.fired).toBe(false);
    expect(r.diag.rewrite.reason).toBe('coverage-met');
    expect(r.output).toBe(rewriteFull);
    expect(r.diag.unresolvedRepos).toEqual([]);
  });

  it('fires a re-write when covered<targets and keeps it when it covers more (provenance-valid)', async () => {
    const r = await resolveProjectsAts({
      first, pool, targets,
      rewrite: async () => rewriteFull,
    });
    expect(r.diag.coverageBefore.covered).toBe(1);
    expect(r.diag.rewrite.fired).toBe(true);
    expect(r.diag.rewrite.coverageAfter?.covered).toBe(2);
    expect(r.diag.rewrite.kept).toBe('rewrite');
    expect(r.diag.rewrite.keptReason).toBe('rewrite-covers-more');
    expect(r.output).toBe(rewriteFull);
    expect(r.diag.provenance.rewriteViolations).toEqual([]);
    expect(r.diag.provenance.firstViolations).toEqual([]);
    expect(r.diag.provenance.composedCount).toBe(1);
  });

  it('keeps first when the re-write gains no coverage', async () => {
    const rewriteNoGain: ProjectsAgentOutput = {
      entries: [
        {
          name: 'Tucaken',
          github: 'github.com/o/tucaken-app',
          description: 'Tucaken is a career platform helping engineers land jobs faster with grounded evidence coaching.',
          highlights: [
            { bulletId: 'p0.b0' },
            { bulletId: 'p0.b1' },
            { text: 'Shipped the coach phone-screen agent end to end', sources: ['p0.r0'] },
          ],
        },
        portfolioEntry,
      ],
    };
    const r = await resolveProjectsAts({
      first, pool, targets,
      rewrite: async () => rewriteNoGain,
    });
    expect(r.diag.rewrite.fired).toBe(true);
    expect(r.diag.rewrite.coverageAfter?.covered).toBe(1);
    expect(r.diag.rewrite.kept).toBe('first');
    expect(r.diag.rewrite.keptReason).toBe('no-coverage-gain');
    expect(r.output).toBe(first);
    expect(r.diag.provenance.composedCount).toBe(0);
  });

  it('keeps first when the re-write throws', async () => {
    const r = await resolveProjectsAts({
      first, pool, targets,
      rewrite: async () => { throw new Error('bedrock 500'); },
    });
    expect(r.diag.rewrite.fired).toBe(true);
    expect(r.diag.rewrite.reason).toBe('rewrite-error');
    expect(r.diag.rewrite.kept).toBe('first');
    expect(r.diag.rewrite.keptReason).toBe('rewrite-threw');
    expect(r.output).toBe(first);
  });

  it('keeps first when the re-write is provenance-invalid (cites another project\'s bullet)', async () => {
    const rewriteBad: ProjectsAgentOutput = {
      entries: [
        {
          name: 'Tucaken',
          github: 'github.com/o/tucaken-app',
          description: 'Tucaken is a career platform helping engineers land jobs faster with grounded evidence coaching.',
          highlights: [
            { bulletId: 'p0.b0' },
            { bulletId: 'p0.b1' },
            // wrong: cites Portfolio's bullet (p1.b0) instead of Tucaken's own p0.r0
            { text: 'Configured DNS resolution for Kubernetes ingress across every cluster', sources: ['p1.b0'] },
          ],
        },
        portfolioEntry,
      ],
    };
    const r = await resolveProjectsAts({
      first, pool, targets,
      rewrite: async () => rewriteBad,
    });
    expect(r.diag.rewrite.fired).toBe(true);
    // coverage would be full (2/2) if it were valid -- proves the guard, not coverage, decided this
    expect(r.diag.rewrite.coverageAfter?.covered).toBe(2);
    expect(r.diag.rewrite.kept).toBe('first');
    expect(r.diag.rewrite.keptReason).toBe('rewrite-provenance-invalid');
    expect(r.output).toBe(first);
    expect(r.diag.provenance.rewriteViolations).toContain('cross_project_citation:Tucaken:p1.b0');
  });
});

describe('joinProjectsText', () => {
  it('joins descriptions and assembled highlights with ". "', () => {
    const text = joinProjectsText(first, pool);
    expect(text).toBe(
      [
        'Tucaken is a career platform helping engineers land jobs faster with grounded evidence coaching.',
        'Built the onboarding flow end to end',
        'Wrote the RLS policies for multi-tenant Kubernetes clusters',
      ].join('. '),
    );
  });
});

describe('deterministicProjects', () => {
  const dnsTarget: ExperienceAtsTarget[] = [
    { skill: 'DNS', source: 'hard', verdict: 'verified', requirement: 'Networking' },
  ];
  const longPitch = Array.from({ length: 45 }, (_, i) => `word${i}`).join(' ');

  const detPool: ProjectPoolEntry[] = [
    {
      index: 0,
      name: 'Networker',
      pitch: longPitch,
      repoUrls: ['github.com/o/networker', 'github.com/o/networker-mirror'],
      curated: [
        { id: 'p0.b0', text: 'Wrote deployment scripts for the staging environment' },
        { id: 'p0.b1', text: 'Documented onboarding steps for new engineers' },
        { id: 'p0.b2', text: 'Configured DNS resolution for internal services' },
      ],
      repoCurrent: [],
    },
    {
      index: 1,
      name: 'Empty',
      pitch: 'a project with no curated bullets yet',
      repoUrls: ['github.com/o/empty'],
      curated: [],
      repoCurrent: [],
    },
  ];

  it('ranks the DNS-target bullet to the lead position, trims the pitch to 40 words, and skips empty-curated projects', () => {
    const result = deterministicProjects(detPool, dnsTarget);
    expect(result).toHaveLength(1);
    const entry = result[0]!;
    expect(entry.name).toBe('Networker');
    expect(entry.highlights[0]).toBe('Configured DNS resolution for internal services');
    expect(entry.highlights).toEqual([
      'Configured DNS resolution for internal services',
      'Wrote deployment scripts for the staging environment',
      'Documented onboarding steps for new engineers',
    ]);
    expect(entry.description.split(/\s+/)).toHaveLength(40);
    expect(entry.description).toBe(Array.from({ length: 40 }, (_, i) => `word${i}`).join(' '));
    expect(entry.github).toBe('github.com/o/networker');
  });
});
