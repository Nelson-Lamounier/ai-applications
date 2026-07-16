/** @format */
import { describe, it, expect } from '@jest/globals';
import { buildProjectsMessage } from '../projects-message.js';

const pool = [
  {
    index: 0,
    name: 'Tucaken',
    pitch: 'AI-driven career platform',
    repoUrls: ['github.com/o/tucaken-app'],
    curated: [{ id: 'p0.b0', text: 'Shipped RLS-scoped multi-tenant Postgres schema' }],
    repoCurrent: [{ id: 'p0.r0', skill: 'DNS', sourceCitation: 'o/tucaken-app/infra/dns.ts', repositoryId: 'r1', githubRepoId: 1, fullName: 'o/tucaken-app' }],
  },
];
const atsTargets = [
  { skill: 'DNS', source: 'hard' as const, verdict: 'verified' as const, requirement: 'Networking concepts and protocols (DNS, TCP/IP, SSL/TLS)', anchors: [] },
];
const base = { pool, atsTargets, targetRole: 'Technical Services Engineer' };

describe('buildProjectsMessage', () => {
  it('emits curated and repo-current lines under the two-lane pool section', () => {
    const msg = buildProjectsMessage(base);
    expect(msg).toContain('## Documented Projects (two-lane pool)');
    expect(msg).toContain('### Tucaken -- AI-driven career platform');
    expect(msg).toContain('Repos: github.com/o/tucaken-app');
    expect(msg).toContain('Curated bullets (quote-only, select by id):');
    expect(msg).toContain('[p0.b0] Shipped RLS-scoped multi-tenant Postgres schema');
    expect(msg).toContain('Repo-current evidence (compose ONLY when a fact beats every curated bullet for JD relevance, cite ids):');
    expect(msg).toContain('[p0.r0] DNS -- o/tucaken-app/infra/dns.ts');
  });

  it('groups ATS targets under their JD requirement and omits the section when empty', () => {
    const msg = buildProjectsMessage(base);
    expect(msg).toContain('## ATS Targets');
    expect(msg).toContain('Networking concepts and protocols (DNS, TCP/IP, SSL/TLS)');
    expect(msg).toContain('- DNS (verified)');
    const bare = buildProjectsMessage({ ...base, atsTargets: [] });
    expect(bare).not.toContain('## ATS Targets');
  });

  it('always includes the composition rules section with the JD-ranked lane-mix + entry-ordering rules '
    + '(Task 3: choose each slot by JD relevance regardless of lane; entries most-JD-relevant first)', () => {
    const msg = buildProjectsMessage(base);
    expect(msg).toContain('## Composition rules');
    expect(msg).toContain('curated');
    expect(msg).toContain('JD relevance regardless of lane');
    expect(msg).toContain('Up to 6 bullets per project, any mix of curated and composed.');
    expect(msg).toContain('ordered most-JD-relevant project first');
  });

  it('groups repo-current facts whose skill is an operations-theme label under an "Operations evidence" sub-heading, leaving other facts under the plain heading', () => {
    const opsPool = [
      {
        ...pool[0]!,
        repoCurrent: [
          { id: 'p0.r0', skill: 'DNS', sourceCitation: 'o/tucaken-app/infra/dns.ts', repositoryId: 'r1', githubRepoId: 1, fullName: 'o/tucaken-app' },
          { id: 'p0.r1', skill: 'database operations', sourceCitation: 'o/tucaken-app/docs/db.md', repositoryId: 'r1', githubRepoId: 1, fullName: 'o/tucaken-app' },
        ],
      },
    ];
    const msg = buildProjectsMessage({ ...base, pool: opsPool });
    expect(msg).toContain('Operations evidence (how this system is OPERATED');
    expect(msg).toContain('[p0.r1] database operations -- o/tucaken-app/docs/db.md');
    // the non-operations fact stays under the plain repo-current heading only.
    const plainIdx = msg.indexOf('Repo-current evidence (compose ONLY');
    const opsIdx = msg.indexOf('Operations evidence (how this system is OPERATED');
    const dnsIdx = msg.indexOf('[p0.r0] DNS -- o/tucaken-app/infra/dns.ts');
    expect(dnsIdx).toBeGreaterThan(plainIdx);
    expect(dnsIdx).toBeLessThan(opsIdx);
  });

  it('omits the "Operations evidence" sub-heading entirely when no repo-current fact is theme-labelled', () => {
    const msg = buildProjectsMessage(base);
    expect(msg).not.toContain('Operations evidence');
  });

  it('adds the re-write block only on the re-write pass', () => {
    expect(buildProjectsMessage(base)).not.toContain('## Re-write pass');
    const rw = buildProjectsMessage({ ...base, rewriteDraft: 'Tucaken -- prior draft', rewriteMissing: ['TCP/IP'] });
    expect(rw).toContain('## Re-write pass');
    expect(rw).toContain('TCP/IP');
    const noMissing = buildProjectsMessage({ ...base, rewriteDraft: 'Tucaken -- prior draft', rewriteMissing: [] });
    expect(noMissing).not.toContain('## Re-write pass');
  });

  it('always restates the composed-bullet four-beat narrative contract + hard style rules, '
    + 'independent of pool/target contents', () => {
    const msg = buildProjectsMessage(base);
    expect(msg).toContain('## Composed-bullet narrative contract');
    expect(msg).toContain('WHAT you did');
    expect(msg).toContain('CONCEPT in public');
    expect(msg).toContain('WHY it mattered');
    expect(msg).toContain('RESULT/VALUE');
    expect(msg).toContain('never a bare "N+" or "Nk+"');
    expect(msg).toContain('Prefer composing the clean version');
  });

  it('adds the style-repair block only when styleFindings is non-empty, listing kind + token', () => {
    expect(buildProjectsMessage(base)).not.toContain('## Style repair');
    const withFindings = buildProjectsMessage({
      ...base,
      styleFindings: [{ kind: 'internal_identifier', token: 'RETRIEVAL_PREFILTER' }, { kind: 'bare_plus_numeric', token: '100+' }],
    });
    expect(withFindings).toContain('## Style repair');
    expect(withFindings).toContain('internal_identifier: "RETRIEVAL_PREFILTER"');
    expect(withFindings).toContain('bare_plus_numeric: "100+"');
    expect(withFindings).toContain('never touch curated quotes');
    const withEmptyFindings = buildProjectsMessage({ ...base, styleFindings: [] });
    expect(withEmptyFindings).not.toContain('## Style repair');
  });
});
