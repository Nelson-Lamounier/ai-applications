/** @format */
import { buildCoachContextChunks, extractCoachClaims } from './coach-grounding.js';
import type { InterviewCoachResult } from '@bedrock/shared';

describe('buildCoachContextChunks', () => {
    it('keeps each non-empty source as its own chunk', () => {
        const chunks = buildCoachContextChunks({
            analysisXml: '<analysis/>',
            evidenceBlock: 'verified matches',
            constraintBlock: 'stage prep',
            skillCandidateBlock: 'candidate block',
        });
        expect(chunks).toEqual(['<analysis/>', 'verified matches', 'stage prep', 'candidate block']);
    });

    it('drops undefined and blank sources', () => {
        const chunks = buildCoachContextChunks({
            analysisXml: '<analysis/>',
            evidenceBlock: undefined,
            constraintBlock: '   ',
        });
        expect(chunks).toEqual(['<analysis/>']);
    });
});

describe('extractCoachClaims', () => {
    const base = {
        stage: 'technical-1',
        stageDescription: 'Technical round.',
        technicalQuestions: [
            { question: 'q', answerFramework: 'Concept then your EKS operator.', sourceProject: 'AI Applications', difficulty: 'medium', keyPoints: ['controller'] },
        ],
        behaviouralQuestions: [],
        difficultQuestions: [{ question: 'q2', answerFramework: 'bridge', bridgeStrategy: 'map to SQS' }],
        technicalPrepChecklist: [{ topic: 'Kafka', priority: 'high', rationale: 'gap', suggestedResources: ['docs'] }],
        questionsToAsk: [{ question: 'on-call?', rationale: 'ops' }],
        coachingNotes: 'Lead with the operator.',
        skillTransfer: [
            { jdSkill: 'Kubernetes', tier: 'demonstrated', projectId: 'p1', projectName: 'AI Applications', evidenceRefs: [{ source: 'component', id: 'c1', label: 'EKS' }], narrative: 'Built an EKS operator.' },
            { jdSkill: 'Kafka', tier: 'gap', projectId: null, projectName: null, evidenceRefs: [], narrative: 'No documented Kafka work.' },
        ],
    } as unknown as InterviewCoachResult;

    it('includes experiential claim surfaces', () => {
        const claims = extractCoachClaims(base);
        expect(claims).toContain('Technical round.');
        expect(claims).toContain('Concept then your EKS operator.');
        expect(claims).toContain('AI Applications');
        expect(claims).toContain('Lead with the operator.');
        expect(claims).toContain('Built an EKS operator.');
    });

    it('excludes pure advice (prep checklist, questions to ask) and gap narratives', () => {
        const claims = extractCoachClaims(base);
        expect(claims).not.toContain('No documented Kafka work.'); // gap narrative
        expect(claims).not.toContain('on-call?');                  // questionsToAsk
        expect(claims).not.toContain('suggestedResources');
    });

    it('includes phone-screen experiential fields', () => {
        const phone = {
            stage: 'phone-screen',
            stageDescription: 'Phone screen.',
            technicalQuestions: [], behaviouralQuestions: [], difficultQuestions: [],
            technicalPrepChecklist: [], questionsToAsk: [], coachingNotes: '',
            careerArcSummary: 'Ten years building platforms.',
            jdTalkingPoints: [{ point: 'Strong AWS', evidence: 'EKS operator in prod' }],
        } as unknown as InterviewCoachResult;
        const claims = extractCoachClaims(phone);
        expect(claims).toContain('Ten years building platforms.');
        expect(claims).toContain('Strong AWS');
        expect(claims).toContain('EKS operator in prod');
    });
});
