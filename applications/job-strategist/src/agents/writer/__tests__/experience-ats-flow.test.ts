/** @format */
import { describe, it, expect } from '@jest/globals';
import { resolveExperienceAts, boundDropped } from '../experience-ats-flow.js';
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
  { skill: 'DNS', source: 'hard', verdict: 'verified', requirement: 'Networking', anchors: [] },
  { skill: 'TCP/IP', source: 'hard', verdict: 'verified', requirement: 'Networking', anchors: [] },
  { skill: 'SSL/TLS', source: 'hard', verdict: 'transferable', requirement: 'Networking', anchors: [] },
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
    expect(r.diag.provenance.dropped).toEqual([]);
  });

  it('propagates bounded accounting.dropped from the kept candidate into diag.provenance.dropped', async () => {
    const firstWithDropped: ExperienceAgentOutput = {
      ...first,
      accounting: { dropped: [{ line: 'c1.h1', reason: 'no ATS-relevant claim survives without fabricating scope' }] },
    };
    const r = await resolveExperienceAts({
      first: firstWithDropped, roster, careerLines: lines, targets,
      rewrite: async () => rewriteFull,
    });
    // kept === 'rewrite' here, so provenance.dropped must come from rewriteFull.accounting.dropped ([]), not first's
    expect(r.diag.rewrite.kept).toBe('rewrite');
    expect(r.diag.provenance.dropped).toEqual([]);
  });

  it('propagates bounded accounting.dropped from params.first on the no-rewrite path', async () => {
    const fullyCoveredWithDropped: ExperienceAgentOutput = {
      ...rewriteFull,
      accounting: { dropped: [{ line: 'c1.h1', reason: 'redundant with kept bullet' }] },
    };
    const r = await resolveExperienceAts({
      first: fullyCoveredWithDropped, roster, careerLines: lines, targets,
      rewrite: async () => rewriteFull,
    });
    expect(r.diag.rewrite.fired).toBe(false);
    expect(r.diag.provenance.dropped).toEqual([{ line: 'c1.h1', reason: 'redundant with kept bullet' }]);
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

  it('keeps first when the re-write is provenance-valid and covers more but trips namesGap', async () => {
    const rewriteGapped: ExperienceAgentOutput = {
      roles: [
        { company: 'AWS', title: 'Support Engineer', period: '2023-2025',
          highlights: [
            {
              text: 'Applied DNS and TCP/IP protocols, though this role falls short of the 8-year bar hardening VPC networking',
              sources: ['c0.h0'], atsTargets: ['DNS', 'TCP/IP'],
            },
            { text: 'Resolved Sev-2 escalations enforcing SSL/TLS security with customer teams', sources: ['c0.h1'], atsTargets: ['SSL/TLS'] },
          ] },
        { company: 'Acme', title: 'QA Analyst', period: '2021-2023',
          highlights: [{ text: 'Automated regression suites gating releases', sources: ['c1.h0'], atsTargets: [] }] },
      ],
      accounting: { dropped: [] },
    };
    const r = await resolveExperienceAts({
      first, roster, careerLines: lines, targets,
      rewrite: async () => rewriteGapped,
    });
    expect(r.diag.rewrite.fired).toBe(true);
    // coverage would be full (3/3) and provenance-valid -- proves namesGap, not coverage or provenance, decided this
    expect(r.diag.rewrite.coverageAfter?.covered).toBe(3);
    expect(r.diag.provenance.rewriteViolations).toEqual([]);
    expect(r.diag.rewrite.kept).toBe('first');
    expect(r.diag.rewrite.keptReason).toBe('rewrite-names-gap');
    expect(r.output).toBe(first);
  });
});

describe('resolveExperienceAts -- term-tolerant, evidence-anchored coverage (Task 3)', () => {
  it('credits a paraphrased bullet that lacks the exact target phrase but names the discriminating term', async () => {
    // "Linux systems engineering" -> requiredTerms strips the generic
    // systems/engineering tokens down to {linux}; no exact phrase anywhere.
    const linuxTargets: ExperienceAtsTarget[] = [
      { skill: 'Linux systems engineering', source: 'hard', verdict: 'verified', requirement: 'Linux', anchors: [] },
    ];
    const paraphrased: ExperienceAgentOutput = {
      roles: [
        { company: 'AWS', title: 'Support Engineer', period: '2023-2025',
          highlights: [
            {
              text: 'Guided customers through Amazon Linux (AL2 and AL2023) system setup and configuration on EC2',
              sources: ['c0.h0'], atsTargets: ['Linux systems engineering'],
            },
            { text: 'Resolved Sev-2 escalations with customer security teams', sources: ['c0.h1'], atsTargets: [] },
          ] },
        { company: 'Acme', title: 'QA Analyst', period: '2021-2023',
          highlights: [{ text: 'Automated regression suites gating releases', sources: ['c1.h0'], atsTargets: [] }] },
      ],
      accounting: { dropped: [] },
    };
    let rewriteCalled = false;
    const r = await resolveExperienceAts({
      first: paraphrased, roster, careerLines: lines, targets: linuxTargets,
      rewrite: async () => { rewriteCalled = true; return paraphrased; },
    });
    expect(r.diag.coverageBefore.covered).toBe(1);
    expect(r.diag.coverageBefore.missing).toEqual([]);
    expect(rewriteCalled).toBe(false); // coverage already met -- no re-write fired
  });

  it('credits an anchor-cited bullet even when its text carries none of the required terms', async () => {
    const anchoredTargets: ExperienceAtsTarget[] = [
      { skill: 'performance and scalability analysis', source: 'hard', verdict: 'verified', requirement: 'Perf', anchors: ['c0.h0'] },
    ];
    const anchoredOnly: ExperienceAgentOutput = {
      roles: [
        { company: 'AWS', title: 'Support Engineer', period: '2023-2025',
          highlights: [
            { text: 'Configured VPC networking and Route53 DNS', sources: ['c0.h0'], atsTargets: [] },
            { text: 'Resolved Sev-2 escalations with customer security teams', sources: ['c0.h1'], atsTargets: [] },
          ] },
        { company: 'Acme', title: 'QA Analyst', period: '2021-2023',
          highlights: [{ text: 'Automated regression suites gating releases', sources: ['c1.h0'], atsTargets: [] }] },
      ],
      accounting: { dropped: [] },
    };
    const r = await resolveExperienceAts({
      first: anchoredOnly, roster, careerLines: lines, targets: anchoredTargets,
      rewrite: async () => anchoredOnly,
    });
    expect(r.diag.coverageBefore.covered).toBe(1);
  });

  it('leaves a zero-anchor, zero-term-match target missing (fail-closed)', async () => {
    const unsupported: ExperienceAtsTarget[] = [
      { skill: 'quantum computing', source: 'hard', verdict: 'verified', requirement: 'Quantum', anchors: [] },
    ];
    const r = await resolveExperienceAts({
      first, roster, careerLines: lines, targets: unsupported,
      rewrite: async () => first,
    });
    expect(r.diag.coverageBefore.covered).toBe(0);
    expect(r.diag.coverageBefore.missing).toEqual(['quantum computing']);
  });
});

describe('boundDropped', () => {
  it('caps each reason at 200 characters', () => {
    const longReason = 'x'.repeat(250);
    const [result] = boundDropped([{ line: 'c0.h0', reason: longReason }]);
    expect(result.reason).toHaveLength(200);
    expect(result.reason).toBe(longReason.slice(0, 200));
  });

  it('leaves a reason under the cap untouched', () => {
    const [result] = boundDropped([{ line: 'c0.h0', reason: 'short reason' }]);
    expect(result.reason).toBe('short reason');
  });

  it('caps the array at 30 entries', () => {
    const dropped = Array.from({ length: 40 }, (_, i) => ({ line: `c0.h${i}`, reason: 'unused' }));
    const result = boundDropped(dropped);
    expect(result).toHaveLength(30);
    expect(result[0].line).toBe('c0.h0');
    expect(result[29].line).toBe('c0.h29');
  });

  it('returns an empty array for an empty input', () => {
    expect(boundDropped([])).toEqual([]);
  });
});
