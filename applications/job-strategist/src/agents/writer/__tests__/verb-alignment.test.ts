/** @format */
import { describe, it, expect } from '@jest/globals';
import { VERB_TIERS, checkVerbAlignment } from '../verb-alignment.js';
import { indexCareerLines } from '../experience-provenance.js';
import type { ExperienceAgentOutput } from '../experience-schema.js';

const entries = [
  { title: 'Support Engineer', company: 'AWS', period: '2023-2025',
    highlights: [
      'Assisted senior engineers with Sev-2 escalations',
      'Took ownership of customer cases -- own cases end-to-end from triage to resolution',
    ] },
];
const lines = indexCareerLines(entries as never);

function outputWith(text: string, sources: string[]): ExperienceAgentOutput {
  return {
    roles: [{
      company: 'AWS', title: 'Support Engineer', period: '2023-2025',
      highlights: [{ text, sources, atsTargets: [] }],
    }],
    accounting: { dropped: [] },
  };
}

describe('VERB_TIERS', () => {
  it('places analyse and analyze both in tier 2', () => {
    expect(VERB_TIERS.get('analyse')).toBe(2);
    expect(VERB_TIERS.get('analyze')).toBe(2);
  });
});

describe('checkVerbAlignment', () => {
  it('flags a lead verb citing only a lower-tier line (live run 1eda06eb shape)', () => {
    const out = outputWith('Owned end-to-end technical resolution of complex customer issues', ['c0.h0']);
    const findings = checkVerbAlignment(out, lines);
    expect(findings).toEqual([{ role: 0, bullet: 0, verb: 'own', tier: 3, ceiling: 1 }]);
  });

  it('is compliant when ANY cited line supports the lead verb -- mid-line "own" counts', () => {
    const out = outputWith('Owned end-to-end technical resolution of complex customer issues', ['c0.h0', 'c0.h1']);
    const findings = checkVerbAlignment(out, lines);
    expect(findings).toEqual([]);
  });

  it('treats an unknown lead verb as neutral -- no finding', () => {
    const out = outputWith('Prototyped a new escalation triage workflow', ['c0.h0']);
    const findings = checkVerbAlignment(out, lines);
    expect(findings).toEqual([]);
  });

  it('skips a leading adverb before resolving the lead verb', () => {
    const out = outputWith('Rapidly self-trained on AWS networking fundamentals', ['c0.h0']);
    const findings = checkVerbAlignment(out, lines);
    expect(findings).toEqual([]);
  });

  it('skips a bullet whose sources do not resolve against the supplied lines', () => {
    const out = outputWith('Owned end-to-end technical resolution of complex customer issues', ['c9.h9']);
    const findings = checkVerbAlignment(out, lines);
    expect(findings).toEqual([]);
  });

  it('skips a bullet with zero sources', () => {
    const out = outputWith('Owned end-to-end technical resolution of complex customer issues', []);
    const findings = checkVerbAlignment(out, lines);
    expect(findings).toEqual([]);
  });

  it('both analyse and analyze resolve to the same tier as the lead verb', () => {
    const british = outputWith('Analysed recurring Sev-2 escalation patterns', ['c0.h0']);
    const american = outputWith('Analyzed recurring Sev-2 escalation patterns', ['c0.h0']);
    const [britishFinding] = checkVerbAlignment(british, lines);
    const [americanFinding] = checkVerbAlignment(american, lines);
    expect(britishFinding?.tier).toBe(2);
    expect(americanFinding?.tier).toBe(2);
    expect(britishFinding?.ceiling).toBe(americanFinding?.ceiling);
  });

  it('REGRESSION: "Designed" resolves via the same-token prefix-match path -- lightStem does not '
    + 'strip a trailing "-ed", so tierOf falls to startsWith("design"); ceiling equals tier (4 == 4), '
    + 'no finding', () => {
    const designEntries = [
      { title: 'QA Lead', company: 'Acme', period: '2021-2023',
        highlights: ['Designed and documented cross-functional QA validation processes for release readiness'] },
    ];
    const designLines = indexCareerLines(designEntries as never);
    const out: ExperienceAgentOutput = {
      roles: [{
        company: 'Acme', title: 'QA Lead', period: '2021-2023',
        highlights: [{
          text: 'Designed and documented cross-functional QA processes ensuring release readiness',
          sources: [designLines[0]!.id],
          atsTargets: [],
        }],
      }],
      accounting: { dropped: [] },
    };
    const findings = checkVerbAlignment(out, designLines);
    expect(findings).toEqual([]);
  });
});
