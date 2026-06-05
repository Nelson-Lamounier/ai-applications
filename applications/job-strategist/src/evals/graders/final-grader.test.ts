/** @format */
import { finalGrader } from './final-grader.js';
import type { EvalInput } from '../graders.js';
import type { InterviewCoachResult } from '@bedrock/shared';

const baseInput = (): EvalInput =>
    ({ analysisXml: '<x/>', candidateSets: [], stage: 'final' } as unknown as EvalInput);

function out(prep: unknown): InterviewCoachResult {
    return { stage: 'final', finalPrep: prep } as unknown as InterviewCoachResult;
}

const goodPrep = {
    whyThisRole: 'This role extends the migration ownership you have demonstrated to a platform scope.',
    mutualFitTalkingPoints: [
        { point: 'I own migrations end-to-end.', grounding: 'Drove the EKS migration controller solo.' },
    ],
    substantiveQuestions: [
        {
            question: 'The JD mentions an EKS migration — does the platform team own the cutover end-to-end?',
            rationale: 'Tells me whether my migration-ownership experience maps to how you run platform work.',
        },
    ],
    longTermFraming: 'I want to move from owning individual migrations to owning platform abstractions.',
};

describe('finalGrader', () => {
    it('is a no-op on non-final stages', () => {
        const input = { analysisXml: '<x/>', candidateSets: [], stage: 'technical-1' } as EvalInput;
        expect(finalGrader(input, out(undefined)).pass).toBe(true);
    });

    it('passes a grounded, specific finalPrep', () => {
        expect(finalGrader(baseInput(), out(goodPrep)).pass).toBe(true);
    });

    it('fails when finalPrep is missing', () => {
        expect(finalGrader(baseInput(), out(undefined)).pass).toBe(false);
    });

    it('fails when whyThisRole is empty/whitespace', () => {
        expect(finalGrader(baseInput(), out({ ...goodPrep, whyThisRole: '   ' })).pass).toBe(false);
    });

    it('fails when longTermFraming is empty', () => {
        expect(finalGrader(baseInput(), out({ ...goodPrep, longTermFraming: '' })).pass).toBe(false);
    });

    it('fails when substantiveQuestions is empty', () => {
        expect(finalGrader(baseInput(), out({ ...goodPrep, substantiveQuestions: [] })).pass).toBe(false);
    });

    it('fails a generic blocklisted question', () => {
        const bad = {
            ...goodPrep,
            substantiveQuestions: [{ question: 'Tell me about the culture.', rationale: 'curious' }],
        };
        expect(finalGrader(baseInput(), out(bad)).pass).toBe(false);
    });

    it('fails a "what is it like" generic question', () => {
        const bad = {
            ...goodPrep,
            substantiveQuestions: [{ question: "What's it like to work on the platform team?", rationale: 'curious' }],
        };
        expect(finalGrader(baseInput(), out(bad)).pass).toBe(false);
    });

    it('fails a talking point with empty grounding', () => {
        const bad = {
            ...goodPrep,
            mutualFitTalkingPoints: [{ point: 'I own migrations.', grounding: '  ' }],
        };
        expect(finalGrader(baseInput(), out(bad)).pass).toBe(false);
    });
});
