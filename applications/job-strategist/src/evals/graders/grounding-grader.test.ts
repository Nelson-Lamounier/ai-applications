/** @format */
import { groundingGrader } from './grounding-grader.js';
import type { EvalInput } from '../graders.js';
import type { InterviewCoachResult, SkillCandidateSet } from '@bedrock/shared';

const SETS: SkillCandidateSet[] = [
    { jdSkill: 'Kubernetes', candidates: [
        { projectId: 'p1', projectName: 'AI Apps', source: 'component', tier: 'demonstrated', id: 'c1', label: 'EKS' },
    ] },
    { jdSkill: 'Kafka', candidates: [] },
];
const input: EvalInput = { analysisXml: '<x/>', candidateSets: SETS, stage: 'technical-1' };

function withTransfer(skillTransfer: unknown): InterviewCoachResult {
    return { skillTransfer } as unknown as InterviewCoachResult;
}

describe('groundingGrader', () => {
    it('passes when every id and projectId is a real candidate and all skills covered', () => {
        const out = withTransfer([
            { jdSkill: 'Kubernetes', tier: 'demonstrated', projectId: 'p1', projectName: 'AI Apps',
              evidenceRefs: [{ source: 'component', id: 'c1', label: 'EKS' }], narrative: 'n' },
            { jdSkill: 'Kafka', tier: 'gap', projectId: null, projectName: null, evidenceRefs: [], narrative: 'gap' },
        ]);
        expect(groundingGrader(input, out).pass).toBe(true);
    });
    it('fails on an invented evidenceRef id', () => {
        const out = withTransfer([
            { jdSkill: 'Kubernetes', tier: 'demonstrated', projectId: 'p1', projectName: 'AI Apps',
              evidenceRefs: [{ source: 'component', id: 'GHOST', label: 'x' }], narrative: 'n' },
            { jdSkill: 'Kafka', tier: 'gap', projectId: null, projectName: null, evidenceRefs: [], narrative: 'g' },
        ]);
        const r = groundingGrader(input, out);
        expect(r.pass).toBe(false);
        expect(r.failures.join(' ')).toContain('GHOST');
    });
    it('fails when a JD skill in the block has no entry', () => {
        const out = withTransfer([
            { jdSkill: 'Kubernetes', tier: 'demonstrated', projectId: 'p1', projectName: 'AI Apps',
              evidenceRefs: [{ source: 'component', id: 'c1', label: 'EKS' }], narrative: 'n' },
        ]);
        const r = groundingGrader(input, out);
        expect(r.pass).toBe(false);
        expect(r.failures.join(' ')).toContain('Kafka');
    });
    it('fails on an invented projectId', () => {
        const out = withTransfer([
            { jdSkill: 'Kubernetes', tier: 'demonstrated', projectId: 'pX', projectName: 'AI Apps',
              evidenceRefs: [{ source: 'component', id: 'c1', label: 'EKS' }], narrative: 'n' },
            { jdSkill: 'Kafka', tier: 'gap', projectId: null, projectName: null, evidenceRefs: [], narrative: 'g' },
        ]);
        const r = groundingGrader(input, out);
        expect(r.pass).toBe(false);
        expect(r.failures.join(' ')).toContain('pX');
    });
});
