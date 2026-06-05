/** @format */
import { barRaiserGrader } from './bar-raiser-grader.js';
import type { EvalInput } from '../graders.js';
import type { InterviewCoachResult } from '@bedrock/shared';

const baseInput = (): EvalInput =>
    ({ analysisXml: '<x/>', candidateSets: [], stage: 'bar-raiser' } as unknown as EvalInput);

function out(cards: unknown): InterviewCoachResult {
    return { stage: 'bar-raiser', barRaiserWalkthrough: cards } as unknown as InterviewCoachResult;
}

const groundedStory = {
    title: 'Owned the migration',
    situation: 'Deploys were slow.',
    task: 'I decided to migrate.',
    action: 'I designed and drove it.',
    result: 'Deploy time dropped.',
    evidenceRefs: [{ source: 'decision', id: 'd1', label: 'EKS migration' }],
    honestyCalibration: "Solo work — frame as 'I drove', NOT 'I led a team'.",
    seniorityNote: 'Reads as senior IC; do not stretch to staff.',
};

const strongCard = {
    principleId: 'amazon.ownership',
    principleName: 'Ownership',
    interpretation: 'Own the outcome end-to-end.',
    coverage: 'strong',
    stories: [groundedStory],
    probingQuestions: [{ question: 'Who else?', framing: 'I owned it end-to-end.' }],
    gapGuidance: null,
};

const gapCard = {
    principleId: 'amazon.hire_and_develop',
    principleName: 'Hire and Develop the Best',
    interpretation: 'Grow other engineers.',
    coverage: 'none',
    stories: [],
    probingQuestions: [],
    gapGuidance: 'No evidence yet — be honest, do not fabricate a mentee.',
};

describe('barRaiserGrader', () => {
    it('is a no-op on non-bar-raiser stages', () => {
        const input = { analysisXml: '<x/>', candidateSets: [], stage: 'technical-1' } as EvalInput;
        expect(barRaiserGrader(input, out([{ ...strongCard, stories: [] }])).pass).toBe(true);
    });

    it('passes a grounded strong card plus an honest gap card', () => {
        expect(barRaiserGrader(baseInput(), out([strongCard, gapCard])).pass).toBe(true);
    });

    it('fails a story with empty honestyCalibration', () => {
        const bad = { ...strongCard, stories: [{ ...groundedStory, honestyCalibration: '' }] };
        expect(barRaiserGrader(baseInput(), out([bad])).pass).toBe(false);
    });

    it('fails a story whose prose inflates solo work into team leadership', () => {
        const bad = { ...strongCard, stories: [{ ...groundedStory, action: 'I led a team through it.' }] };
        expect(barRaiserGrader(baseInput(), out([bad])).pass).toBe(false);
    });

    it('fails a story with no evidenceRefs', () => {
        const bad = { ...strongCard, stories: [{ ...groundedStory, evidenceRefs: [] }] };
        expect(barRaiserGrader(baseInput(), out([bad])).pass).toBe(false);
    });

    it('fails a gap card (coverage=none) missing gapGuidance', () => {
        const bad = { ...gapCard, gapGuidance: null };
        expect(barRaiserGrader(baseInput(), out([bad])).pass).toBe(false);
    });

    it('fails a coverage=none card that still carries stories', () => {
        const bad = { ...gapCard, gapGuidance: 'honest gap', stories: [groundedStory] };
        expect(barRaiserGrader(baseInput(), out([bad])).pass).toBe(false);
    });

    it('fails a partial card missing gapGuidance', () => {
        const bad = { ...strongCard, coverage: 'partial', gapGuidance: null };
        expect(barRaiserGrader(baseInput(), out([bad])).pass).toBe(false);
    });
});
