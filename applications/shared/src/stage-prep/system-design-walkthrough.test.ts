/** @format */
import { validateSystemDesignWalkthrough } from './system-design-walkthrough.js';
import type { ConcernCoverage, SystemDesignWalkthroughCard } from './index.js';

const coverage: ConcernCoverage = {
  detected: [
    { concernId: 'rls', category: 'data_isolation', strength: 'strong',
      evidenceRefs: [{ source: 'component', id: 'c1', label: 'RLS layer' }], relevantToJd: true },
    { concernId: 'scale', category: 'scaling', strength: 'none', evidenceRefs: [], relevantToJd: true },
  ],
  relevantTotal: 2, relevantAddressed: 1,
};

const grounded: SystemDesignWalkthroughCard = {
  concernId: 'rls', concernQuestion: 'q', whyItMatters: 'w',
  evidenceRefs: [{ source: 'component', id: 'c1', label: 'RLS layer' }],
  choiceMade: 'Postgres RLS', articulation: 'I chose RLS…',
  followUps: [{ question: 'forgot filter?', status: 'addressed', framing: 'RLS enforces it' }],
  gapGuidance: null,
};

describe('validateSystemDesignWalkthrough', () => {
  it('keeps a fully grounded card unchanged', () => {
    const out = validateSystemDesignWalkthrough([grounded], coverage);
    expect(out).toEqual([grounded]);
  });

  it('drops a card for an unknown concern', () => {
    const ghost = { ...grounded, concernId: 'unknown' };
    expect(validateSystemDesignWalkthrough([ghost], coverage)).toEqual([]);
  });

  it('demotes a card that cites an invented evidence id', () => {
    const invented = { ...grounded, evidenceRefs: [{ source: 'component', id: 'FAKE', label: 'x' }] };
    const [card] = validateSystemDesignWalkthrough([invented], coverage);
    expect(card.choiceMade).toBeNull();
    expect(card.evidenceRefs).toEqual([]);
    expect(card.followUps.every(f => f.status === 'gap')).toBe(true);
  });

  it('passes through an honest gap card for a none-strength concern', () => {
    const gap: SystemDesignWalkthroughCard = {
      concernId: 'scale', concernQuestion: 'q', whyItMatters: 'w', evidenceRefs: [],
      choiceMade: null, articulation: 'No evidence; here is how I would approach it…',
      followUps: [{ question: 'how scale?', status: 'gap', framing: 'honest' }], gapGuidance: 'be honest',
    };
    expect(validateSystemDesignWalkthrough([gap], coverage)).toEqual([gap]);
  });
});
