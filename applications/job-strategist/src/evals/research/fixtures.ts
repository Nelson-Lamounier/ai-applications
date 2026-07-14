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
    {
        // Guards the career-history authority tier (research-persona v3): a
        // role-level responsibility the candidate PERFORMED in a paid role is
        // verified on career grounds (evidenceFiles: []), while a named tool
        // claimed only by job title stays partial (the tier-3 LIMIT), and a
        // skill with no role or KB evidence is honestly a gap.
        name: 'experience-attested-responsibilities',
        jdSkills: [
            'Production incident response',       // on-call held in a paid role → verified (career, tier 3)
            'Customer-facing technical support',  // core role responsibility     → verified (career, tier 3)
            'Kubernetes',                         // proven in repos              → verified (KB, tier 2)
            'Kafka',                              // named tool, no KB demo, not a role duty → partial (tier 3 LIMIT)
            'People management',                  // no role or KB evidence       → gap
        ],
        expectedVerdicts: {
            'Production incident response': 'verified',
            'Customer-facing technical support': 'verified',
            'Kubernetes': 'verified',
            'Kafka': 'partial',
            'People management': 'gap',
        },
    },
];

/**
 * A correct model output for `experience-attested-responsibilities` — the
 * career-history authority path (research-persona v3, tier 3). The two role
 * responsibilities are VERIFIED on career grounds with evidenceFiles: [] (no KB
 * passage), the named tool with no demonstration is PARTIAL, and the unevidenced
 * skill is honestly a GAP. Pins that the graders accept career-only verification.
 */
export const GOLDEN_OUTPUT_EXPERIENCE: ResearchEvalOutput = {
    overallFitRating: 'REASONABLE FIT',
    fitSummary: 'Role responsibilities well covered by paid support/SRE history; Kafka is transferable, no people-management evidence.',
    assessments: [
        { skill: 'Production incident response', verdict: 'verified', sourceCitation: 'Technical Support role — production on-call rotation', depth: 'working', recency: '2025', evidenceFiles: [] },
        { skill: 'Customer-facing technical support', verdict: 'verified', sourceCitation: 'Technical Customer Service Associate — direct customer troubleshooting', depth: 'expert', recency: '2025', evidenceFiles: [] },
        { skill: 'Kubernetes', verdict: 'verified', sourceCitation: 'self-healing project', depth: 'working', recency: '2026', evidenceFiles: ['me/infra/k8s.yaml'] },
        { skill: 'Kafka', verdict: 'partial', gapDescription: 'no Kafka in stack', transferableFoundation: 'event-driven exposure via SQS/SNS', framingSuggestion: 'frame async messaging experience as transferable', evidenceFiles: [] },
        { skill: 'People management', verdict: 'gap', gapType: 'soft', impactSeverity: 'minor', disqualifyingAssessment: 'no reports or lead role in the record' },
    ],
};

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
