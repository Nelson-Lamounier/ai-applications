/** @format */
import { schemaGrader } from './schema-grader.js';
import type { EvalInput } from '../graders.js';
import type { InterviewCoachResult } from '@bedrock/shared';

const BASE = {
    stage: 'technical-1',
    stageDescription: 'd',
    technicalQuestions: [], behaviouralQuestions: [], difficultQuestions: [],
    technicalPrepChecklist: [], questionsToAsk: [], coachingNotes: 'n',
} as unknown as InterviewCoachResult;

const tech: EvalInput = { analysisXml: '<x/>', candidateSets: [], stage: 'technical-1' };
const phone: EvalInput = { analysisXml: '<x/>', candidateSets: [], stage: 'phone-screen' };

describe('schemaGrader', () => {
    it('passes a valid non-phone payload', () => {
        expect(schemaGrader(tech, BASE).pass).toBe(true);
    });
    it('fails when a required field is missing', () => {
        const bad = { ...BASE, coachingNotes: undefined } as unknown as InterviewCoachResult;
        expect(schemaGrader(tech, bad).pass).toBe(false);
    });
    it('fails phone-screen missing the required phone fields', () => {
        const r = schemaGrader(phone, BASE);
        expect(r.pass).toBe(false);
        expect(r.failures.join(' ')).toContain('careerArcSummary');
    });
    it('fails non-phone stage that includes phone-only fields', () => {
        const withPhone = { ...BASE, careerArcSummary: 'arc' } as unknown as InterviewCoachResult;
        const r = schemaGrader(tech, withPhone);
        expect(r.pass).toBe(false);
        expect(r.failures.join(' ')).toContain('omit');
    });
    it('passes a valid phone-screen payload with all three fields', () => {
        const ok = {
            ...BASE, stage: 'phone-screen',
            careerArcSummary: 'arc',
            jdTalkingPoints: [{ point: 'p', evidence: 'e' }],
            compScript: { targetEcho: 't', marketContext: null, deflectTemplate: 'd' },
        } as unknown as InterviewCoachResult;
        expect(schemaGrader(phone, ok).pass).toBe(true);
    });
});
