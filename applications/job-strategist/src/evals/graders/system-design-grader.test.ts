/** @format */
import { systemDesignGrader } from './system-design-grader.js';
import type { EvalInput } from '../graders.js';
import type { InterviewCoachResult } from '@bedrock/shared';

const baseInput = (): EvalInput => ({ analysisXml: '<x/>', candidateSets: [], stage: 'system-design' });

const coverage = {
    detected: [{ concernId: 'rls', category: 'data_isolation', strength: 'strong',
        evidenceRefs: [{ source: 'component', id: 'c1', label: 'RLS' }], relevantToJd: true }],
    relevantTotal: 1, relevantAddressed: 1,
};

function out(cards: unknown): InterviewCoachResult {
    return { stage: 'system-design', systemDesignWalkthrough: cards, systemDesignCoverage: coverage } as unknown as InterviewCoachResult;
}

describe('systemDesignGrader', () => {
    it('passes a grounded card that covers the relevant concern', () => {
        const r = systemDesignGrader(baseInput(), out([{ concernId: 'rls', concernQuestion: 'q', whyItMatters: 'w',
            evidenceRefs: [{ source: 'component', id: 'c1', label: 'RLS' }], choiceMade: 'RLS', articulation: 'I…',
            followUps: [], gapGuidance: null }]));
        expect(r.pass).toBe(true);
    });
    it('fails when a card cites an evidence id not in the detected set', () => {
        const r = systemDesignGrader(baseInput(), out([{ concernId: 'rls', concernQuestion: 'q', whyItMatters: 'w',
            evidenceRefs: [{ source: 'component', id: 'FAKE', label: 'x' }], choiceMade: 'RLS', articulation: 'I…',
            followUps: [], gapGuidance: null }]));
        expect(r.pass).toBe(false);
    });
    it('fails when a JD-relevant concern has no card', () => {
        const r = systemDesignGrader(baseInput(), out([]));
        expect(r.pass).toBe(false);
    });
});
