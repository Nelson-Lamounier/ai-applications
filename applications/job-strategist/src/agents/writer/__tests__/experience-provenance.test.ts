/** @format */
import { describe, it, expect } from '@jest/globals';
import {
  indexCareerLines, rosterFromCareer, validateExperienceProvenance, assembleExperience,
} from '../experience-provenance.js';
import type { ExperienceAgentOutput } from '../experience-schema.js';

const entries = [
  { title: 'Support Engineer', company: 'AWS', period: '2023-2025',
    highlights: ['Configured VPC networking and Route53 DNS', 'Resolved Sev-2 escalations'] },
  { title: 'QA Analyst', company: 'Acme', period: '2021-2023', highlights: ['Automated regression suites'] },
];
const lines = indexCareerLines(entries as never);
const roster = rosterFromCareer(entries as never);

const good: ExperienceAgentOutput = {
  roles: [
    { company: 'AWS', title: 'Support Engineer', period: '2023-2025',
      highlights: [
        { text: 'Applied networking protocols (DNS, TCP/IP) hardening VPC connectivity', sources: ['c0.h0'], atsTargets: ['DNS', 'TCP/IP'] },
        { text: 'Resolved Sev-2 escalations with customer security teams', sources: ['c0.h1'], atsTargets: [] },
      ] },
    { company: 'Acme', title: 'QA Analyst', period: '2021-2023',
      highlights: [{ text: 'Automated regression suites gating releases', sources: ['c1.h0'], atsTargets: [] }] },
  ],
  accounting: { dropped: [] },
};

describe('experience provenance', () => {
  it('indexes lines as c{i}.h{j} and builds the roster', () => {
    expect(lines.map((l) => l.id)).toEqual(['c0.h0', 'c0.h1', 'c1.h0']);
    expect(roster[0]).toEqual({ company: 'AWS', title: 'Support Engineer', period: '2023-2025' });
  });
  it('accepts a fully-cited, fully-accounted output', () => {
    expect(validateExperienceProvenance(good, roster, lines)).toEqual([]);
  });
  it('rejects a bullet citing another employer\'s line', () => {
    const bad = structuredClone(good);
    bad.roles[1]!.highlights[0]!.sources = ['c0.h0'];
    expect(validateExperienceProvenance(bad, roster, lines)).toContain('cross_role_citation:Acme:c0.h0');
  });
  it('rejects when a career line is neither used nor dropped', () => {
    const bad = structuredClone(good);
    bad.roles[0]!.highlights = [bad.roles[0]!.highlights[0]!];
    expect(validateExperienceProvenance(bad, roster, lines)).toContain('unaccounted_line:c0.h1');
  });
  it('rejects roster drift (renamed title)', () => {
    const bad = structuredClone(good);
    bad.roles[0]!.title = 'Senior Support Engineer';
    expect(validateExperienceProvenance(bad, roster, lines)).toContain('roster_drift:0');
  });
  it('rejects an uncited bullet and enforces max 5 bullets', () => {
    const bad = structuredClone(good);
    bad.roles[0]!.highlights[0]!.sources = [];
    expect(validateExperienceProvenance(bad, roster, lines)).toContain('uncited_bullet:AWS:0');
    const six = structuredClone(good);
    six.roles[0]!.highlights = Array.from({ length: 6 }, () => ({ text: 'x', sources: ['c0.h0'], atsTargets: [] }));
    six.accounting.dropped = [{ line: 'c0.h1', reason: 'redundant' }];
    expect(validateExperienceProvenance(six, roster, lines)).toContain('bullet_count:AWS:6');
  });
  it('assembles plain-string highlights preserving order', () => {
    expect(assembleExperience(good)[0]).toEqual({
      company: 'AWS', title: 'Support Engineer', period: '2023-2025',
      highlights: [
        'Applied networking protocols (DNS, TCP/IP) hardening VPC connectivity',
        'Resolved Sev-2 escalations with customer security teams',
      ],
    });
  });
});
