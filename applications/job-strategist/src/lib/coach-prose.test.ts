/** @format */
import { extractProseSections } from './coach-prose.js';
import type { InterviewCoachResult } from '@bedrock/shared';

const coaching = {
    stage: 'phone_screen',
    stageDescription: 'Recruiter screen.',
    coachingNotes: 'Be concise.',
    careerArcSummary: 'Backend to platform.',
    jdTalkingPoints: [{ point: 'Led migration.', evidence: 'proj-1' }],
    technicalQuestions: [{ question: 'Q', answerFramework: 'STAR on the migration.', sourceProject: 'proj-1' }],
    behaviouralQuestions: [{ question: 'Q2', answerFramework: 'Conflict story.', sourceProject: 'proj-2' }],
    skillTransfer: [
        { jdSkill: 'k8s', tier: 'direct', narrative: 'Ran the cluster.' },
        { jdSkill: 'rust', tier: 'gap', narrative: 'No evidence.' },
    ],
} as unknown as InterviewCoachResult;

describe('extractProseSections', () => {
    const sections = extractProseSections(coaching);
    const at = (loc: string) => sections.find(s => s.location === loc);

    it('tags stageDescription as narrative', () => {
        expect(at('stageDescription')?.register).toBe('narrative');
    });
    it('tags coachingNotes as advice', () => {
        expect(at('coachingNotes')?.register).toBe('advice');
    });
    it('tags jdTalkingPoints[0].point as resume-prose', () => {
        expect(at('jdTalkingPoints[0].point')?.text).toBe('Led migration.');
        expect(at('jdTalkingPoints[0].point')?.register).toBe('resume-prose');
    });
    it('tags answer frameworks as storytelling', () => {
        expect(at('technicalQuestions[0].answerFramework')?.register).toBe('storytelling');
        expect(at('behaviouralQuestions[0].answerFramework')?.register).toBe('storytelling');
    });
    it('includes non-gap skillTransfer narrative, excludes gap entries', () => {
        expect(at('skillTransfer[0].narrative')?.text).toBe('Ran the cluster.');
        expect(sections.some(s => s.text === 'No evidence.')).toBe(false);
    });
    it('skips empty/missing fields', () => {
        const empty = extractProseSections({ stage: 'technical' } as unknown as InterviewCoachResult);
        expect(empty).toEqual([]);
    });
});
