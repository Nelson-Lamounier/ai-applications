/** @format */
import { describe, it, expect } from '@jest/globals';
import { resolveExperienceAts } from '../experience-ats-flow.js';
import { indexCareerLines, rosterFromCareer } from '../experience-provenance.js';
import type { ExperienceAgentOutput } from '../experience-schema.js';
import type { ExperienceAtsTarget } from '../../../ats/gate/experience-ats-targets.js';

const entries = [
  { title: 'Support Engineer', company: 'AWS', period: '2023-2025',
    highlights: ['Configured VPC networking and Route53 DNS', 'Resolved Sev-2 escalations with customer security teams'] },
  { title: 'QA Analyst', company: 'Acme', period: '2021-2023', highlights: ['Automated regression suites'] },
];
const lines = indexCareerLines(entries as never);
const roster = rosterFromCareer(entries as never);

const targets: ExperienceAtsTarget[] = [
  { skill: 'DNS', source: 'hard', verdict: 'verified', requirement: 'Networking' },
  { skill: 'TCP/IP', source: 'hard', verdict: 'verified', requirement: 'Networking' },
  { skill: 'SSL/TLS', source: 'hard', verdict: 'transferable', requirement: 'Networking' },
];

// covers DNS only (1/3)
const first: ExperienceAgentOutput = {
  roles: [
    { company: 'AWS', title: 'Support Engineer', period: '2023-2025',
      highlights: [
        { text: 'Applied DNS resolution and VPC networking practices', sources: ['c0.h0'], atsTargets: ['DNS'] },
        { text: 'Resolved Sev-2 escalations with customer security teams', sources: ['c0.h1'], atsTargets: [] },
      ] },
    { company: 'Acme', title: 'QA Analyst', period: '2021-2023',
      highlights: [{ text: 'Automated regression suites gating releases', sources: ['c1.h0'], atsTargets: [] }] },
  ],
  accounting: { dropped: [] },
};

// covers DNS + TCP/IP + SSL/TLS (3/3), provenance-valid
const rewriteFull: ExperienceAgentOutput = {
  roles: [
    { company: 'AWS', title: 'Support Engineer', period: '2023-2025',
      highlights: [
        { text: 'Applied DNS and TCP/IP protocols hardening VPC networking', sources: ['c0.h0'], atsTargets: ['DNS', 'TCP/IP'] },
        { text: 'Resolved Sev-2 escalations enforcing SSL/TLS security with customer teams', sources: ['c0.h1'], atsTargets: ['SSL/TLS'] },
      ] },
    { company: 'Acme', title: 'QA Analyst', period: '2021-2023',
      highlights: [{ text: 'Automated regression suites gating releases', sources: ['c1.h0'], atsTargets: [] }] },
  ],
  accounting: { dropped: [] },
};

describe('resolveExperienceAts', () => {
  it('fires a re-write when covered<targets and keeps it when it covers more (provenance-valid)', async () => {
    const r = await resolveExperienceAts({
      first, roster, careerLines: lines, targets,
      rewrite: async () => rewriteFull,
    });
    expect(r.diag.coverageBefore.covered).toBe(1);
    expect(r.diag.rewrite.fired).toBe(true);
    expect(r.diag.rewrite.coverageAfter?.covered).toBe(3);
    expect(r.diag.rewrite.kept).toBe('rewrite');
    expect(r.diag.rewrite.keptReason).toBe('rewrite-covers-more');
    expect(r.output).toBe(rewriteFull);
    expect(r.diag.provenance.rewriteViolations).toEqual([]);
    expect(r.diag.provenance.firstViolations).toEqual([]);
  });

  it('keeps first when the re-write gains no coverage', async () => {
    const rewriteNoGain: ExperienceAgentOutput = {
      roles: [
        { company: 'AWS', title: 'Support Engineer', period: '2023-2025',
          highlights: [
            { text: 'Applied DNS resolution improving VPC networking uptime', sources: ['c0.h0'], atsTargets: ['DNS'] },
            { text: 'Resolved Sev-2 escalations with customer security teams reliably', sources: ['c0.h1'], atsTargets: [] },
          ] },
        { company: 'Acme', title: 'QA Analyst', period: '2021-2023',
          highlights: [{ text: 'Automated regression suites gating releases quickly', sources: ['c1.h0'], atsTargets: [] }] },
      ],
      accounting: { dropped: [] },
    };
    const r = await resolveExperienceAts({
      first, roster, careerLines: lines, targets,
      rewrite: async () => rewriteNoGain,
    });
    expect(r.diag.rewrite.fired).toBe(true);
    expect(r.diag.rewrite.coverageAfter?.covered).toBe(1);
    expect(r.diag.rewrite.kept).toBe('first');
    expect(r.diag.rewrite.keptReason).toBe('no-coverage-gain');
    expect(r.output).toBe(first);
  });

  it('does not fire a re-write when coverage is already full', async () => {
    let called = false;
    const r = await resolveExperienceAts({
      first: rewriteFull, roster, careerLines: lines, targets,
      rewrite: async () => { called = true; return rewriteFull; },
    });
    expect(called).toBe(false);
    expect(r.diag.rewrite.fired).toBe(false);
    expect(r.diag.rewrite.reason).toBe('coverage-met');
    expect(r.output).toBe(rewriteFull);
  });

  it('keeps first when the re-write throws', async () => {
    const r = await resolveExperienceAts({
      first, roster, careerLines: lines, targets,
      rewrite: async () => { throw new Error('bedrock 500'); },
    });
    expect(r.diag.rewrite.fired).toBe(true);
    expect(r.diag.rewrite.reason).toBe('rewrite-error');
    expect(r.diag.rewrite.kept).toBe('first');
    expect(r.output).toBe(first);
  });

  it('keeps first when the re-write is provenance-invalid (cites another role\'s line)', async () => {
    const rewriteBad: ExperienceAgentOutput = {
      roles: [
        { company: 'AWS', title: 'Support Engineer', period: '2023-2025',
          highlights: [
            { text: 'Applied DNS and TCP/IP protocols hardening VPC networking', sources: ['c0.h0'], atsTargets: ['DNS', 'TCP/IP'] },
            { text: 'Resolved Sev-2 escalations enforcing SSL/TLS security with customer teams', sources: ['c0.h1'], atsTargets: ['SSL/TLS'] },
          ] },
        { company: 'Acme', title: 'QA Analyst', period: '2021-2023',
          // wrong: cites AWS's line (c0.h0) instead of its own (c1.h0)
          highlights: [{ text: 'Automated regression suites gating releases', sources: ['c0.h0'], atsTargets: [] }] },
      ],
      accounting: { dropped: [] },
    };
    const r = await resolveExperienceAts({
      first, roster, careerLines: lines, targets,
      rewrite: async () => rewriteBad,
    });
    expect(r.diag.rewrite.fired).toBe(true);
    // coverage would be full (3/3) if it were valid -- proves the guard, not coverage, decided this
    expect(r.diag.rewrite.coverageAfter?.covered).toBe(3);
    expect(r.diag.rewrite.kept).toBe('first');
    expect(r.diag.rewrite.keptReason).toBe('rewrite-provenance-invalid');
    expect(r.output).toBe(first);
    expect(r.diag.provenance.rewriteViolations).toContain('cross_role_citation:Acme:c0.h0');
    expect(r.diag.provenance.rewriteViolations).toContain('unaccounted_line:c1.h0');
  });
});
