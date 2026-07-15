/**
 * @format
 * Bar Raiser grounding spine — deterministic principle→evidence detection,
 * prompt-block rendering, and anti-invention validation. Mirrors the
 * System Design grounding tests (concern-detection / system-design-walkthrough).
 */
import type { ProjectEvidenceInput } from '@bedrock/shared';
import type { LeadershipPrinciple } from '../leadership-principles-repository.js';
import {
  detectPrincipleEvidence,
  buildBarRaiserBlock,
  validateBarRaiserWalkthrough,
  type BarRaiserPrinciple,
  type PrincipleCoverage,
} from '../bar-raiser-grounding.js';

const emptyEvidence: ProjectEvidenceInput = {
  projects: [],
  components: [],
  decisions: [],
  stackItems: [],
  tags: [],
  highlights: [],
  challenges: [],
  repoEvidence: [],
};

function principle(over: Partial<LeadershipPrinciple> = {}): LeadershipPrinciple {
  return {
    principleId: 'ownership',
    name: 'Ownership',
    interpretation: 'Acts on behalf of the whole, beyond own team.',
    signalKeywords: ['ownership', 'migration', 'oncall'],
    storyShapes: ['Drove a cross-team migration'],
    probingPatterns: ['Tell me about a time you owned an outcome'],
    failureModes: ['Blamed another team'],
    ...over,
  };
}

describe('detectPrincipleEvidence', () => {
  it('returns strong when signalKeywords overlap a demonstrated evidence source', () => {
    const evidence: ProjectEvidenceInput = {
      ...emptyEvidence,
      projects: [{ id: 'p1', name: 'Platform' }],
      components: [{ id: 'c1', projectId: 'p1', name: 'Migration runner', kind: 'service' }],
      decisions: [{ id: 'd1', projectId: 'p1', title: 'Adopt oncall rotation', decision: 'paged' }],
    };
    const cov = detectPrincipleEvidence([principle()], evidence, '');
    expect(cov).toHaveLength(1);
    expect(cov[0].coverage).toBe('strong');
    const ids = cov[0].evidenceRefs.map(r => r.id).sort();
    expect(ids).toEqual(['c1', 'd1']);
  });

  it('returns none when no signalKeyword overlaps any evidence', () => {
    const evidence: ProjectEvidenceInput = {
      ...emptyEvidence,
      projects: [{ id: 'p1', name: 'Platform' }],
      components: [{ id: 'c1', projectId: 'p1', name: 'Login form', kind: 'ui' }],
    };
    const cov = detectPrincipleEvidence([principle()], evidence, '');
    expect(cov[0].coverage).toBe('none');
    expect(cov[0].evidenceRefs).toEqual([]);
  });

  it('returns partial when only a weak (claimed/declared) source matches', () => {
    const evidence: ProjectEvidenceInput = {
      ...emptyEvidence,
      projects: [{ id: 'p1', name: 'Platform' }],
      tags: [{ projectId: 'p1', tag: 'migration' }],
    };
    const cov = detectPrincipleEvidence([principle()], evidence, '');
    expect(cov[0].coverage).toBe('partial');
    expect(cov[0].evidenceRefs.map(r => r.id)).toEqual(['p1:migration']);
  });

  it('flags relevantToJd by jdText overlap with signalKeywords', () => {
    const evidence = { ...emptyEvidence };
    const relevant = detectPrincipleEvidence([principle()], evidence, 'must show ownership of the oncall rotation');
    const irrelevant = detectPrincipleEvidence([principle()], evidence, 'frontend css work');
    expect(relevant[0].relevantToJd).toBe(true);
    expect(irrelevant[0].relevantToJd).toBe(false);
  });
});

describe('buildBarRaiserBlock', () => {
  it('renders one section per relevant principle with detected evidence + shapes', () => {
    const cov: PrincipleCoverage[] = [{
      principleId: 'ownership',
      coverage: 'strong',
      evidenceRefs: [{ source: 'component', id: 'c1', label: 'Migration runner' }],
      relevantToJd: true,
    }];
    const block = buildBarRaiserBlock(cov, [principle()]);
    expect(block).toContain('Ownership');
    expect(block).toContain('c1');
    expect(block).toContain('Migration runner');
    expect(block).toContain('Drove a cross-team migration');
  });

  it('returns empty string when no principle is relevant to the JD', () => {
    const cov: PrincipleCoverage[] = [{
      principleId: 'ownership', coverage: 'strong', evidenceRefs: [], relevantToJd: false,
    }];
    expect(buildBarRaiserBlock(cov, [principle()])).toBe('');
  });
});

describe('validateBarRaiserWalkthrough', () => {
  const coverage: PrincipleCoverage[] = [{
    principleId: 'ownership',
    coverage: 'strong',
    evidenceRefs: [{ source: 'component', id: 'c1', label: 'Migration runner' }],
    relevantToJd: true,
  }];

  function card(over: Partial<BarRaiserPrinciple> = {}): BarRaiserPrinciple {
    return {
      principleId: 'ownership',
      principleName: 'Ownership',
      interpretation: 'Acts on behalf of the whole.',
      coverage: 'strong',
      stories: [{
        title: 'Owned the migration',
        situation: 's', task: 't', action: 'a', result: 'r',
        evidenceRefs: [{ source: 'component', id: 'c1', label: 'Migration runner' }],
        honestyCalibration: 'demonstrated',
        seniorityNote: 'mid',
      }],
      probingQuestions: [{ question: 'q', framing: 'f' }],
      gapGuidance: null,
      ...over,
    };
  }

  it('keeps stories whose evidenceRefs are a subset of the detected set', () => {
    const out = validateBarRaiserWalkthrough([card()], coverage);
    expect(out[0].stories).toHaveLength(1);
    expect(out[0].coverage).toBe('strong');
  });

  it('drops a story citing an evidence id NOT in the detected set', () => {
    const invented = card({
      stories: [{
        title: 'Invented',
        situation: 's', task: 't', action: 'a', result: 'r',
        evidenceRefs: [{ source: 'component', id: 'GHOST', label: 'made up' }],
        honestyCalibration: 'claimed',
        seniorityNote: 'mid',
      }],
    });
    const out = validateBarRaiserWalkthrough([invented], coverage);
    expect(out[0].stories).toEqual([]);
    expect(out[0].coverage).toBe('none');
    expect(out[0].gapGuidance).toBeTruthy();
  });

  it('demotes a card to coverage none + gapGuidance when all stories are dropped', () => {
    const mixed = card({
      stories: [
        {
          title: 'Real', situation: 's', task: 't', action: 'a', result: 'r',
          evidenceRefs: [{ source: 'component', id: 'c1', label: 'Migration runner' }],
          honestyCalibration: 'demonstrated', seniorityNote: 'mid',
        },
        {
          title: 'Fake', situation: 's', task: 't', action: 'a', result: 'r',
          evidenceRefs: [{ source: 'component', id: 'NOPE', label: 'x' }],
          honestyCalibration: 'claimed', seniorityNote: 'mid',
        },
      ],
    });
    const out = validateBarRaiserWalkthrough([mixed], coverage);
    // The grounded story survives; the invented one is dropped.
    expect(out[0].stories.map(s => s.title)).toEqual(['Real']);
    expect(out[0].coverage).toBe('strong');
  });

  it('drops cards for unknown principles', () => {
    const unknown = card({ principleId: 'not-a-principle' });
    expect(validateBarRaiserWalkthrough([unknown], coverage)).toEqual([]);
  });
});
