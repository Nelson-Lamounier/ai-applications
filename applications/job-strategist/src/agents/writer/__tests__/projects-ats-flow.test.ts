/** @format */
import { describe, it, expect } from '@jest/globals';
import { resolveProjectsAts, deterministicProjects, scoreProjectsCoverage, sumProjectsNormalisedExtras } from '../projects-ats-flow.js';
import type { ProjectsAgentOutput } from '../projects-schema.js';
import type { ProjectPoolEntry } from '../../evidence/project-agent-inputs.js';
import type { ExperienceAtsTarget } from '../../../ats/gate/experience-ats-targets.js';
import type { StyleFinding } from '../projects-style.js';

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
  { skill: 'Kubernetes', source: 'hard', verdict: 'verified', requirement: 'Infra', anchors: [] },
  { skill: 'DNS', source: 'hard', verdict: 'verified', requirement: 'Networking', anchors: [] },
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

// Component 3/4: composed-bullet narrative style guard, routed into the
// SAME existing ATS re-write call (never a new trigger) -- see
// resolveProjectsAts's own doc comment above.
describe('resolveProjectsAts -- composed-bullet style guard (Component 3)', () => {
  it('a style finding alone never triggers a re-write -- coverage-met stays advisory-only', async () => {
    const firstDirtyCovered: ProjectsAgentOutput = {
      entries: [
        {
          name: 'Tucaken',
          github: 'github.com/o/tucaken-app',
          description: 'Tucaken is a career platform helping engineers land jobs faster with grounded evidence coaching.',
          highlights: [
            { bulletId: 'p0.b0' },
            { bulletId: 'p0.b1' }, // Kubernetes
            { text: 'Configured (RETRIEVAL_PREFILTER) for DNS resolution across every cluster', sources: ['p0.r0'] }, // DNS
          ],
        },
        portfolioEntry,
      ],
    };
    let called = false;
    const r = await resolveProjectsAts({
      first: firstDirtyCovered, pool, targets,
      rewrite: async () => { called = true; return firstDirtyCovered; },
    });
    expect(called).toBe(false);
    expect(r.diag.rewrite.fired).toBe(false);
    expect(r.diag.rewrite.reason).toBe('coverage-met');
    expect(r.diag.style.composedFindings).toBe(1);
    expect(r.diag.style.curatedAdvisories).toBe(0);
    expect(r.diag.style.kinds).toEqual({ internal_identifier: 1 });
  });

  it('a curated bullet carrying the same style patterns is advisory-only -- NEVER routed for repair', async () => {
    const styleCuratedPool: ProjectPoolEntry[] = [
      {
        index: 0,
        name: 'Tucaken',
        pitch: 'career platform',
        repoUrls: ['github.com/o/tucaken-app'],
        curated: [{ id: 'p0.b0', text: 'Scaled the retrieval pipeline to handle 100+ concurrent requests.' }],
        repoCurrent: [],
      },
    ];
    const curatedOnly: ProjectsAgentOutput = {
      entries: [{ name: 'Tucaken', github: 'github.com/o/tucaken-app', description: '', highlights: [{ bulletId: 'p0.b0' }] }],
    };
    let called = false;
    const r = await resolveProjectsAts({
      first: curatedOnly, pool: styleCuratedPool, targets: [],
      rewrite: async () => { called = true; return curatedOnly; },
    });
    expect(called).toBe(false); // no-targets short-circuit -- proves advisory alone never calls the model
    expect(r.diag.style.composedFindings).toBe(0);
    expect(r.diag.style.curatedAdvisories).toBe(1);
    expect(r.diag.style.kinds).toEqual({ bare_plus_numeric: 1 });
  });

  it('when the coverage re-write already fires, the first draft\'s composed style findings are handed to '
    + 'the SAME rewrite call, and a clean rewrite zeroes out diag.style on the kept output', async () => {
    const firstDirty: ProjectsAgentOutput = {
      entries: [
        {
          name: 'Tucaken',
          github: 'github.com/o/tucaken-app',
          description: 'Tucaken is a career platform helping engineers land jobs faster with grounded evidence coaching.',
          highlights: [
            { bulletId: 'p0.b0' },
            { bulletId: 'p0.b1' }, // Kubernetes only -- DNS still missing, coverage 1/2
            { text: 'Wired the RETRIEVAL_PREFILTER stage to speed up lookups', sources: ['p0.r0'] },
          ],
        },
        portfolioEntry,
      ],
    };
    let captured: readonly StyleFinding[] | undefined;
    const r = await resolveProjectsAts({
      first: firstDirty, pool, targets,
      rewrite: async (_draftText, _missing, styleFindings) => {
        captured = styleFindings;
        return rewriteFull; // clean, provenance-valid, covers both targets
      },
    });
    expect(captured).toEqual([{ kind: 'internal_identifier', token: 'RETRIEVAL_PREFILTER' }]);
    expect(r.diag.rewrite.fired).toBe(true);
    expect(r.diag.rewrite.kept).toBe('rewrite');
    expect(r.diag.style.composedFindings).toBe(0);
    expect(r.diag.style.curatedAdvisories).toBe(0);
  });

  it('an invalid rewrite ships the ORIGINAL, and diag.style reflects the ORIGINAL\'s findings -- never a fallback', async () => {
    const firstDirty: ProjectsAgentOutput = {
      entries: [
        {
          name: 'Tucaken',
          github: 'github.com/o/tucaken-app',
          description: 'Tucaken is a career platform helping engineers land jobs faster with grounded evidence coaching.',
          highlights: [
            { bulletId: 'p0.b0' },
            { bulletId: 'p0.b1' },
            { text: 'Wired the RETRIEVAL_PREFILTER stage to speed up lookups', sources: ['p0.r0'] },
          ],
        },
        portfolioEntry,
      ],
    };
    const rewriteBad: ProjectsAgentOutput = {
      entries: [
        {
          name: 'Tucaken',
          github: 'github.com/o/tucaken-app',
          description: 'Tucaken is a career platform helping engineers land jobs faster with grounded evidence coaching.',
          highlights: [
            { bulletId: 'p0.b0' },
            { bulletId: 'p0.b1' },
            // cites Portfolio's bullet -- provenance-invalid
            { text: 'Configured DNS resolution for Kubernetes ingress across every cluster', sources: ['p1.b0'] },
          ],
        },
        portfolioEntry,
      ],
    };
    const r = await resolveProjectsAts({
      first: firstDirty, pool, targets,
      rewrite: async () => rewriteBad,
    });
    expect(r.diag.rewrite.kept).toBe('first');
    expect(r.diag.rewrite.keptReason).toBe('rewrite-provenance-invalid');
    expect(r.output).toBe(firstDirty);
    expect(r.diag.style.composedFindings).toBe(1); // the ORIGINAL's own finding, not the (discarded) rewrite's
    expect(r.diag.style.kinds).toEqual({ internal_identifier: 1 });
  });
});

describe('deterministicProjects', () => {
  const dnsTarget: ExperienceAtsTarget[] = [
    { skill: 'DNS', source: 'hard', verdict: 'verified', requirement: 'Networking', anchors: [] },
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

  it('ranks the DNS-target bullet to the lead position, stamps the description from the pitch, and skips empty-curated projects', () => {
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
    // Task 2: description is the stampProjectDescription output, not the old
    // ad hoc 40-word trim -- a 45-word run-on pitch is under the 80-word cap
    // and ships whole.
    expect(entry.description).toBe(longPitch);
    expect(entry.github).toBe('github.com/o/networker');
  });

  it('Task 3: ranks a bullet to the lead position via TERM-MATCH, not exact phrase -- a bullet that '
    + 'never says "Linux systems engineering" verbatim still outranks unrelated bullets because it '
    + "demonstrates the target's distinctive core {linux} (experienceTermMatch semantics)", () => {
    const linuxTarget: ExperienceAtsTarget[] = [
      { skill: 'Linux systems engineering', source: 'hard', verdict: 'verified', requirement: 'Systems', anchors: [] },
    ];
    const linuxPool: ProjectPoolEntry[] = [
      {
        index: 0,
        name: 'Support',
        pitch: 'internal support tooling for platform engineers',
        repoUrls: ['github.com/o/support'],
        curated: [
          { id: 'p0.b0', text: 'Wrote onboarding documentation for new hires' },
          {
            id: 'p0.b1',
            text: 'Guided customers through Amazon Linux system setup and configuration on EC2, covering '
              + 'instance provisioning and OS-level troubleshooting',
          },
          { id: 'p0.b2', text: 'Triaged customer support tickets across every product line' },
        ],
        repoCurrent: [],
      },
    ];
    const result = deterministicProjects(linuxPool, linuxTarget);
    expect(result[0]!.highlights[0]).toBe(
      'Guided customers through Amazon Linux system setup and configuration on EC2, covering '
        + 'instance provisioning and OS-level troubleshooting',
    );
  });

  it('description is the pitch STAMP (reconciler refuse-empty fallback path): first paragraph only, sentence-capped at 80 words', () => {
    const sentence = (n: number): string => `Sentence number ${n} has exactly ten words in it total.`;
    const longParagraph = Array.from({ length: 10 }, (_, i) => sentence(i)).join(' '); // 100 words
    const stampPool: ProjectPoolEntry[] = [
      {
        index: 0,
        name: 'MultiPara',
        pitch: `First paragraph pitch for humans.\n\nSecond paragraph internal note that must never ship.`,
        repoUrls: ['github.com/o/multipara'],
        curated: [{ id: 'p0.b0', text: 'A curated bullet' }],
        repoCurrent: [],
      },
      {
        index: 1,
        name: 'LongPitch',
        pitch: longParagraph,
        repoUrls: ['github.com/o/longpitch'],
        curated: [{ id: 'p1.b0', text: 'Another curated bullet' }],
        repoCurrent: [],
      },
    ];

    const result = deterministicProjects(stampPool, []);
    expect(result).toHaveLength(2);
    expect(result[0]!.description).toBe('First paragraph pitch for humans.');
    expect(result[0]!.description).not.toContain('Second paragraph');
    const capped = result[1]!.description;
    expect(capped.trim().split(/\s+/).length).toBeLessThanOrEqual(80);
    expect(capped.endsWith('.')).toBe(true); // whole sentences only, never mid-sentence
    expect(longParagraph.startsWith(capped)).toBe(true);
  });

  // G3 empty-pitch edge: a project with no pitch falls back to its tagline.
  it('description falls back to the pool entry\'s tagline when pitch is empty', () => {
    const taglinePool: ProjectPoolEntry[] = [
      {
        index: 0,
        name: 'NoPitch',
        pitch: '',
        tagline: 'A one-line project summary.',
        repoUrls: ['github.com/o/no-pitch'],
        curated: [{ id: 'p0.b0', text: 'A curated bullet' }],
        repoCurrent: [],
      },
    ];
    const result = deterministicProjects(taglinePool, []);
    expect(result[0]!.description).toBe('A one-line project summary.');
  });

  it('description stays empty when both pitch and tagline are empty/absent', () => {
    const emptyBothPool: ProjectPoolEntry[] = [
      {
        index: 0,
        name: 'NoPitchNoTagline',
        pitch: '',
        repoUrls: ['github.com/o/nothing'],
        curated: [{ id: 'p0.b0', text: 'A curated bullet' }],
        repoCurrent: [],
      },
    ];
    const result = deterministicProjects(emptyBothPool, []);
    expect(result[0]!.description).toBe('');
  });
});

// Task 3: term-rule v2 -- coverage scoring and fallback ranking both move
// from the strict exact-adjacent-phrase `scoreSummaryCoverage` to
// `experienceTermMatch` semantics (via `scoreExperienceCoverage`).
describe('scoreProjectsCoverage (Task 3 term-rule v2 -- experienceTermMatch parity)', () => {
  it('credits a target via term-match semantics without the exact phrase -- parity with the experience '
    + "lane's REGRESSION fixture (\"Linux systems engineering\" / the real Amazon Linux bullet); the OLD "
    + 'exact-adjacent-phrase scorer would have missed this (the bullet never says the literal phrase) -- '
    + 'this is the MongoDB TSE live-run bug (0/6 coverage despite relevant bullets)', () => {
    const linuxPool: ProjectPoolEntry[] = [
      {
        index: 0,
        name: 'Support',
        pitch: 'internal support tooling for platform engineers',
        repoUrls: ['github.com/o/support'],
        curated: [{
          id: 'p0.b0',
          text: 'Guided customers through Amazon Linux (AL2 and AL2023) system setup and configuration on EC2, '
            + 'covering instance provisioning, SSH access and key management, package and systemd service '
            + 'configuration, and OS-level troubleshooting of boot, storage, and network connectivity issues.',
        }],
        repoCurrent: [],
      },
    ];
    const linuxTargets: ExperienceAtsTarget[] = [
      { skill: 'Linux systems engineering', source: 'hard', verdict: 'verified', requirement: 'Systems', anchors: [] },
    ];
    const out: ProjectsAgentOutput = {
      entries: [{
        name: 'Support',
        github: 'github.com/o/support',
        description: 'Support is internal support tooling for platform engineers.',
        highlights: [{ bulletId: 'p0.b0' }],
      }],
    };
    const result = scoreProjectsCoverage(out, linuxPool, linuxTargets);
    expect(result.covered).toBe(1);
    expect(result.missing).toEqual([]);
  });

  it('never scores the description -- Task 2 locked it to the pitch stamp, so a description mentioning '
    + 'a target must NOT count as coverage on its own', () => {
    const pitchOnlyPool: ProjectPoolEntry[] = [
      {
        index: 0,
        name: 'Support',
        pitch: 'a Kubernetes-based internal support platform',
        repoUrls: ['github.com/o/support'],
        curated: [{ id: 'p0.b0', text: 'Wrote onboarding documentation for new hires' }],
        repoCurrent: [],
      },
    ];
    const out: ProjectsAgentOutput = {
      entries: [{
        name: 'Support',
        github: 'github.com/o/support',
        description: 'Support is a Kubernetes-based internal support platform.',
        highlights: [{ bulletId: 'p0.b0' }],
      }],
    };
    const targets: ExperienceAtsTarget[] = [
      { skill: 'Kubernetes', source: 'hard', verdict: 'verified', requirement: 'Infra', anchors: [] },
    ];
    expect(scoreProjectsCoverage(out, pitchOnlyPool, targets).covered).toBe(0);
  });
});

describe('deterministicProjects entry ordering (Task 3: JD-ranked lane mix)', () => {
  const k8sTargets: ExperienceAtsTarget[] = [
    { skill: 'Kubernetes', source: 'hard', verdict: 'verified', requirement: 'Infra', anchors: [] },
  ];

  // Pool order deliberately puts the near-zero-signal project FIRST -- proves
  // reordering happens rather than an accidental pool-order pass-through.
  const mixedPool: ProjectPoolEntry[] = [
    {
      index: 0,
      name: 'FrontendPortfolio',
      pitch: 'a personal portfolio site built with React and CSS animations',
      repoUrls: ['github.com/o/frontend-portfolio'],
      curated: [
        { id: 'p0.b0', text: 'Styled responsive layouts with CSS grid and flexbox' },
        { id: 'p0.b1', text: 'Animated page transitions using a JavaScript animation library' },
      ],
      repoCurrent: [],
    },
    {
      index: 1,
      name: 'Platform',
      pitch: 'the internal platform team\'s infrastructure services',
      repoUrls: ['github.com/o/platform'],
      curated: [
        { id: 'p1.b0', text: 'Ran production workloads on Kubernetes clusters across every environment' },
      ],
      repoCurrent: [],
    },
  ];

  it('ranks the Kubernetes-flavoured Platform entry above the near-zero-signal FrontendPortfolio entry '
    + '-- the MongoDB TSE live-run regression (frontend bullets shipped while Kubernetes evidence sat unused)', () => {
    const result = deterministicProjects(mixedPool, k8sTargets);
    expect(result.map((r) => r.name)).toEqual(['Platform', 'FrontendPortfolio']);
  });

  it('keeps the pool order on a tie (neither entry term-matches the target)', () => {
    const noSignalTargets: ExperienceAtsTarget[] = [
      { skill: 'Rust', source: 'hard', verdict: 'verified', requirement: 'Systems', anchors: [] },
    ];
    const result = deterministicProjects(mixedPool, noSignalTargets);
    expect(result.map((r) => r.name)).toEqual(['FrontendPortfolio', 'Platform']);
  });

  it('keeps the pool order when there are no targets at all', () => {
    const result = deterministicProjects(mixedPool, []);
    expect(result.map((r) => r.name)).toEqual(['FrontendPortfolio', 'Platform']);
  });
});

// Owed micro-test (Task 2): fillResumeProjects (run-pipeline.ts) sums the
// first draft's and any re-write's normalisedExtras into the persisted
// ProjectsAgentDiagnostics -- fillResumeProjects itself is not directly
// unit-testable (async agent calls through a DB-backed pipeline context), so
// the extracted pure helper it calls is tested directly here.
describe('sumProjectsNormalisedExtras (fillResumeProjects extras-summation glue)', () => {
  it('sums the first draft and re-write counts', () => {
    expect(sumProjectsNormalisedExtras(2, 3)).toBe(5);
  });

  it('a zero re-write count (no re-write fired) keeps the first draft count', () => {
    expect(sumProjectsNormalisedExtras(4, 0)).toBe(4);
  });

  it('both zero -> zero', () => {
    expect(sumProjectsNormalisedExtras(0, 0)).toBe(0);
  });
});
