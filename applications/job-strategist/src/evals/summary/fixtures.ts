/**
 * @format
 * Synthetic summary-agent (B1) eval fixtures - no Bedrock, no PII.
 *
 * GOLDEN_SUMMARY is a hand-written summary that passes every structural
 * grader in summary-graders.ts; the grader test proves the graders accept a
 * genuinely good summary rather than merely rejecting bad ones.
 *
 * ADVERSARIAL_FIT exists as a future input for the live runner (B2b): its
 * fitSummary names a shortfall the way a research-agent fit assessment
 * legitimately would, while its (inherited) resume summary must stay
 * guard-safe and never echo that shortfall.
 */
import type { SummaryEvalInput } from './summary-graders.js';

const BODY = {
    summary: '',
    profile: {},
    skills: [],
    education: [],
    certifications: [],
    keyAchievements: [],
    sectionOrder: [],
    experience: [
        { company: 'AWS', title: 'Support Engineer', period: '2023-2025', highlights: ['Operated production on-call; cut MTTR by 30%'] },
    ],
    projects: [
        { name: 'Tucaken', description: '', highlights: ['Built an event-driven API on SQS/SNS'], github: '' },
    ],
} as unknown as SummaryEvalInput['body'];

/**
 * Passes every grader: no gap language, no shared numbers (the summary has
 * no numbers at all), <=100 words, no banned phrases, no target-company
 * mention, no gap-skill token.
 */
export const GOLDEN_SUMMARY: SummaryEvalInput = {
    summary:
        'Backend engineer who ships reliable services and owns production operations end to end. ' +
        'Applies event-driven design and disciplined on-call practice so teams deliver dependably. ' +
        'Depth in infrastructure the code proves and the resume understates. ' +
        'Every change is gated by automated tests before it reaches production.',
    body: BODY,
    fitSummary: 'Strong backend match; production on-call proven; Kafka transferable via SQS/SNS.',
    gapSkills: ['Go', 'Kafka'],
    targetCompany: 'Acme',
};

/** Adversarial: the Fit Summary names a shortfall; the resume summary must NOT echo it. */
export const ADVERSARIAL_FIT: SummaryEvalInput = {
    ...GOLDEN_SUMMARY,
    fitSummary: 'Reasonable fit but falls short of the 8-year bar and lacks Go.',
};

/**
 * ATS-aware golden: surfaces the literal target keywords (Kubernetes, AWS) inside a
 * fit-thesis narrative while passing every structural guard -- proves ATS-awareness
 * does not break the narrative/guard invariants.
 */
export const GOLDEN_ATS_SUMMARY: SummaryEvalInput = {
    summary:
        'Backend engineer who ships reliable services on Kubernetes and AWS, owning production operations end to end. ' +
        'Applies event-driven design and disciplined release practice so teams deliver dependably. ' +
        'Depth in infrastructure the code proves and the resume understates. ' +
        'Every change is gated by automated tests before it reaches production.',
    body: BODY,
    fitSummary: 'Strong backend match; Kubernetes and AWS proven.',
    gapSkills: ['Go', 'Kafka'],
    targetCompany: 'Acme',
    atsTargets: [
        { skill: 'Kubernetes', source: 'hard', verdict: 'verified' },
        { skill: 'AWS', source: 'hard', verdict: 'verified' },
        { skill: 'Terraform', source: 'hard', verdict: 'transferable' },
    ],
};
