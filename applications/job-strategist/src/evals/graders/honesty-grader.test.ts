/** @format */
import { honestyGrader } from './honesty-grader.js';
import type { EvalInput } from '../graders.js';
import type { InterviewCoachResult, SkillCandidateSet } from '@bedrock/shared';

const SETS: SkillCandidateSet[] = [
    { jdSkill: 'K8s', candidates: [{ projectId: 'p1', projectName: 'A', source: 'component', tier: 'demonstrated', id: 'c1', label: 'EKS' }] },
];
const input: EvalInput = { analysisXml: '<x/>', candidateSets: SETS, stage: 'technical-1' };
const out = (skillTransfer: unknown) => ({ skillTransfer } as unknown as InterviewCoachResult);

describe('honestyGrader', () => {
    it('passes when entries already honest (validate is a no-op)', () => {
        const r = honestyGrader(input, out([
            { jdSkill: 'K8s', tier: 'demonstrated', projectId: 'p1', projectName: 'A',
              evidenceRefs: [{ source: 'component', id: 'c1', label: 'EKS' }], narrative: 'n' },
        ]));
        expect(r.pass).toBe(true);
    });
    it('fails when an entry would be demoted by validateSkillTransfer', () => {
        const r = honestyGrader(input, out([
            { jdSkill: 'K8s', tier: 'demonstrated', projectId: 'p1', projectName: 'A',
              evidenceRefs: [{ source: 'component', id: 'GHOST', label: 'x' }], narrative: 'n' },
        ]));
        expect(r.pass).toBe(false);
        expect(r.failures.join(' ')).toContain('demoted');
    });
    it('passes with no skillTransfer (nothing to verify)', () => {
        expect(honestyGrader(input, out(undefined)).pass).toBe(true);
    });
});
