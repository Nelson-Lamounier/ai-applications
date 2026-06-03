/** @format */
import { allowedIds, allowedProjectIds, runGraders } from './graders.js';
import type { Grader, EvalInput } from './graders.js';
import type { InterviewCoachResult, SkillCandidateSet } from '@bedrock/shared';

const SETS: SkillCandidateSet[] = [
    { jdSkill: 'Kubernetes', candidates: [
        { projectId: 'p1', projectName: 'AI Apps', source: 'component', tier: 'demonstrated', id: 'c1', label: 'EKS' },
    ] },
    { jdSkill: 'Kafka', candidates: [] },
];

const INPUT: EvalInput = { analysisXml: '<x/>', candidateSets: SETS, stage: 'technical-1' };
const OUTPUT = {} as InterviewCoachResult;

describe('graders core', () => {
    it('allowedIds collects every candidate id', () => {
        expect(allowedIds(SETS)).toEqual(new Set(['c1']));
    });
    it('allowedProjectIds collects every candidate projectId', () => {
        expect(allowedProjectIds(SETS)).toEqual(new Set(['p1']));
    });
    it('runGraders aggregates pass=false when any grader fails', () => {
        const ok: Grader = () => ({ grader: 'ok', pass: true, score: 1, failures: [] });
        const bad: Grader = () => ({ grader: 'bad', pass: false, score: 0, failures: ['x'] });
        const report = runGraders([ok, bad], INPUT, OUTPUT);
        expect(report.pass).toBe(false);
        expect(report.results).toHaveLength(2);
    });
    it('runGraders pass=true when all pass', () => {
        const ok: Grader = () => ({ grader: 'ok', pass: true, score: 1, failures: [] });
        expect(runGraders([ok], INPUT, OUTPUT).pass).toBe(true);
    });
});
