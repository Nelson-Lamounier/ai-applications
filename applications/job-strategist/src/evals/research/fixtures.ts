/**
 * @format
 * Synthetic research-agent eval fixtures — no Bedrock, no PII.
 *
 * Each fixture is a canonical JD skill list + a labelled verdict key (the
 * "right" assessment a competent matcher should produce given the implied
 * evidence). The live runner (run-research-eval.ts) compares real Haiku vs
 * Sonnet output against these; the offline grader tests use the GOLDEN_OUTPUT
 * to prove the graders themselves behave.
 */
import type { ResearchEvalCase, ResearchEvalOutput } from './research-graders.js';

export const FIXTURES: ResearchEvalCase[] = [
    {
        name: 'devops-sre-mixed',
        jdSkills: ['Kubernetes', 'Terraform', 'AWS', 'Go', 'On-call incident response', '8+ years experience'],
        expectedVerdicts: {
            'Kubernetes': 'verified',
            'Terraform': 'partial',          // candidate uses CDK
            'AWS': 'verified',
            'Go': 'gap',                      // not in stack
            'On-call incident response': 'verified',
            '8+ years experience': 'gap',     // hard years bar not met
        },
    },
    {
        name: 'ai-support-engineer',
        jdSkills: ['Python', 'OpenAI API', 'SaaS troubleshooting', 'Customer relationship management'],
        expectedVerdicts: {
            'Python': 'verified',
            'OpenAI API': 'partial',          // bridged via Bedrock/Claude
            'SaaS troubleshooting': 'verified',
            'Customer relationship management': 'partial',
        },
    },
];

/** A correct model output for `devops-sre-mixed` — exercises every grader's pass path. */
export const GOLDEN_OUTPUT: ResearchEvalOutput = {
    overallFitRating: 'STRETCH',
    fitSummary: 'Strong infra match; short of the hard years bar and missing Go.',
    assessments: [
        { skill: 'Kubernetes', verdict: 'verified', sourceCitation: 'self-healing project', depth: 'expert', recency: '2026', evidenceFiles: ['me/infra/k8s.yaml'] },
        { skill: 'Terraform', verdict: 'partial', gapDescription: 'uses CDK', transferableFoundation: 'IaC via CDK transfers', framingSuggestion: 'frame CDK as modern IaC', evidenceFiles: ['me/infra/stack.ts'] },
        { skill: 'AWS', verdict: 'verified', sourceCitation: 'cdk-monitoring', depth: 'working', recency: '2026', evidenceFiles: ['me/infra/aws.ts'] },
        { skill: 'Go', verdict: 'gap', gapType: 'soft', impactSeverity: 'minor', disqualifyingAssessment: 'preferred, not blocking' },
        { skill: 'On-call incident response', verdict: 'verified', sourceCitation: 'AWS support role', depth: 'working', recency: '2025' },
        { skill: '8+ years experience', verdict: 'gap', gapType: 'hard', impactSeverity: 'significant', disqualifyingAssessment: '~5 relevant years vs 8+ bar' },
    ],
};
