/** @format */
import { stageFocusGrader } from './stage-focus-grader.js';
import type { EvalInput } from '../graders.js';
import type { InterviewCoachResult, SkillCandidateSet } from '@bedrock/shared';

const withCands: SkillCandidateSet[] = [
    { jdSkill: 'K8s', candidates: [{ projectId: 'p1', projectName: 'A', source: 'component', tier: 'demonstrated', id: 'c1', label: 'EKS' }] },
];

describe('stageFocusGrader', () => {
    it('phone-screen passes with comp/career/talking points populated', () => {
        const out = {
            careerArcSummary: 'arc',
            jdTalkingPoints: [{ point: 'p', evidence: 'e' }],
            compScript: { targetEcho: 't', marketContext: null, deflectTemplate: 'd' },
            behaviouralQuestions: [],
        } as unknown as InterviewCoachResult;
        const input: EvalInput = { analysisXml: '<x/>', candidateSets: [], stage: 'phone-screen' };
        expect(stageFocusGrader(input, out).pass).toBe(true);
    });
    it('phone-screen fails with empty jdTalkingPoints', () => {
        const out = { careerArcSummary: 'arc', jdTalkingPoints: [], compScript: { targetEcho: 't', marketContext: null, deflectTemplate: 'd' } } as unknown as InterviewCoachResult;
        const input: EvalInput = { analysisXml: '<x/>', candidateSets: [], stage: 'phone-screen' };
        expect(stageFocusGrader(input, out).pass).toBe(false);
    });
    it('technical fails when candidates exist but skillTransfer is empty', () => {
        const out = { skillTransfer: [], behaviouralQuestions: [] } as unknown as InterviewCoachResult;
        const input: EvalInput = { analysisXml: '<x/>', candidateSets: withCands, stage: 'technical-1' };
        expect(stageFocusGrader(input, out).pass).toBe(false);
    });
    it('system-design fails when candidates exist but skillTransfer is empty', () => {
        const out = { skillTransfer: [], behaviouralQuestions: [] } as unknown as InterviewCoachResult;
        const input: EvalInput = { analysisXml: '<x/>', candidateSets: withCands, stage: 'system-design' };
        expect(stageFocusGrader(input, out).pass).toBe(false);
    });
    it('system-design passes when candidates exist and skillTransfer is populated', () => {
        const out = { skillTransfer: [{ jdSkill: 'K8s', tier: 'demonstrated', projectId: 'p1', projectName: 'A', evidenceRefs: [{ source: 'component', id: 'c1', label: 'EKS' }], narrative: 'n' }] } as unknown as InterviewCoachResult;
        const input: EvalInput = { analysisXml: '<x/>', candidateSets: withCands, stage: 'system-design' };
        expect(stageFocusGrader(input, out).pass).toBe(true);
    });
    it('behavioural fails with no behaviouralQuestions', () => {
        const out = { behaviouralQuestions: [] } as unknown as InterviewCoachResult;
        const input: EvalInput = { analysisXml: '<x/>', candidateSets: [], stage: 'behavioural' };
        expect(stageFocusGrader(input, out).pass).toBe(false);
    });
});
