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
    expect(msg).toContain('Repo-current evidence (compose at most 2 bullets per project, cite ids):');
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

  it('always includes the composition rules section', () => {
    const msg = buildProjectsMessage(base);
    expect(msg).toContain('## Composition rules');
    expect(msg).toContain('curated');
    expect(msg).toContain('at most 2 bullets per project');
  });

  it('adds the re-write block only on the re-write pass', () => {
    expect(buildProjectsMessage(base)).not.toContain('## Re-write pass');
    const rw = buildProjectsMessage({ ...base, rewriteDraft: 'Tucaken -- prior draft', rewriteMissing: ['TCP/IP'] });
    expect(rw).toContain('## Re-write pass');
    expect(rw).toContain('TCP/IP');
    const noMissing = buildProjectsMessage({ ...base, rewriteDraft: 'Tucaken -- prior draft', rewriteMissing: [] });
    expect(noMissing).not.toContain('## Re-write pass');
  });
});
