/**
 * @format
 * Synthetic experience-agent eval fixtures - no Bedrock, no PII.
 *
 * GOLDEN_NETWORKING is a hand-written experience output that passes every
 * structural grader in experience-graders.ts; the grader test proves the
 * graders accept a genuinely good output rather than merely rejecting bad
 * ones. The adversarial variants each break exactly one grader's invariant.
 */
import type { CareerEntry } from '../../agents/evidence/career-history.js';
import { indexCareerLines, rosterFromCareer } from '../../agents/writer/experience-provenance.js';
import type { ExperienceAgentOutput } from '../../agents/writer/experience-schema.js';
import type { ExperienceAtsTarget } from '../../ats/gate/experience-ats-targets.js';
import type { ExperienceEvalInput } from './experience-graders.js';

const NETWORKING_REQUIREMENT = 'Networking concepts and protocols (DNS, TCP/IP, SSL/TLS, etc)';

const CAREER_ENTRIES: CareerEntry[] = [
    {
        title: 'Support Engineer',
        company: 'AWS',
        period: '2023-2025',
        highlights: [
            'Configured VPC networking, security groups and Route53 DNS records',
            'Resolved elevated escalations with customer security teams',
        ],
    },
    {
        title: 'QA Analyst',
        company: 'Acme',
        period: '2021-2023',
        highlights: ['Automated regression suites gating releases'],
    },
];

const CAREER_LINES = indexCareerLines(CAREER_ENTRIES);
const ROSTER = rosterFromCareer(CAREER_ENTRIES);

const NETWORKING_TARGETS: ExperienceAtsTarget[] = [
    { skill: 'DNS', source: 'hard', verdict: 'verified', requirement: NETWORKING_REQUIREMENT },
    { skill: 'TCP/IP', source: 'hard', verdict: 'verified', requirement: NETWORKING_REQUIREMENT },
    { skill: 'SSL/TLS', source: 'hard', verdict: 'transferable', requirement: NETWORKING_REQUIREMENT },
];

/**
 * Passes every grader: provenance-clean (every bullet cites a career line of
 * its own role, every line accounted for), no invented numbers (the only
 * number token, "53" from "Route53", is present in its cited source line
 * too), weaves DNS + SSL/TLS into the LEAD AWS bullet (2/3 targets - meets
 * the min(2,N) coverage bar), every bullet is short with <=2 number tokens,
 * and the covering bullet leads its role.
 */
const GOLDEN_OUTPUT: ExperienceAgentOutput = {
    roles: [
        {
            company: 'AWS',
            title: 'Support Engineer',
            period: '2023-2025',
            highlights: [
                {
                    text: 'Configured VPC networking and DNS resolution, enforcing SSL/TLS security across Route53 records',
                    sources: ['c0.h0'],
                    atsTargets: ['DNS', 'SSL/TLS'],
                },
                {
                    text: 'Resolved elevated escalations with customer security teams',
                    sources: ['c0.h1'],
                    atsTargets: [],
                },
            ],
        },
        {
            company: 'Acme',
            title: 'QA Analyst',
            period: '2021-2023',
            highlights: [{ text: 'Automated regression suites gating releases', sources: ['c1.h0'], atsTargets: [] }],
        },
    ],
    accounting: { dropped: [] },
};

export const GOLDEN_NETWORKING: ExperienceEvalInput = {
    output: GOLDEN_OUTPUT,
    roster: ROSTER,
    careerLines: CAREER_LINES,
    atsTargets: NETWORKING_TARGETS,
    allowedNumbers: [],
};

/**
 * Adversarial: the Acme bullet cites AWS's career line (c0.h0) instead of its
 * own (c1.h0) -- trips `cross_role_citation` AND leaves c1.h0 unaccounted, so
 * ONLY provenanceGrader fails; text is unchanged so every other grader still
 * passes.
 */
export const ADVERSARIAL_CROSS_ROLE: ExperienceEvalInput = {
    ...GOLDEN_NETWORKING,
    output: {
        ...GOLDEN_OUTPUT,
        roles: [
            GOLDEN_OUTPUT.roles[0],
            {
                ...GOLDEN_OUTPUT.roles[1],
                highlights: [{ text: 'Automated regression suites gating releases', sources: ['c0.h0'], atsTargets: [] }],
            },
        ],
    },
};

/**
 * Adversarial: the second AWS bullet claims an invented "47%" that appears in
 * neither `allowedNumbers` nor its cited source line -- trips ONLY
 * noFabricationGrader; provenance, coverage, voice and reorder are unaffected.
 */
export const ADVERSARIAL_FABRICATION: ExperienceEvalInput = {
    ...GOLDEN_NETWORKING,
    output: {
        ...GOLDEN_OUTPUT,
        roles: [
            {
                ...GOLDEN_OUTPUT.roles[0],
                highlights: [
                    GOLDEN_OUTPUT.roles[0].highlights[0],
                    {
                        text: 'Resolved elevated escalations with customer security teams, cutting response time by 47%',
                        sources: ['c0.h1'],
                        atsTargets: [],
                    },
                ],
            },
            GOLDEN_OUTPUT.roles[1],
        ],
    },
};

/**
 * Adversarial: the AWS role's covering bullet (DNS/SSL-TLS) is demoted to
 * second place behind a non-covering bullet -- trips ONLY reorderGrader;
 * provenance, numbers, coverage totals and per-bullet voice are unaffected by
 * the reorder.
 */
export const ADVERSARIAL_REORDER: ExperienceEvalInput = {
    ...GOLDEN_NETWORKING,
    output: {
        ...GOLDEN_OUTPUT,
        roles: [
            {
                ...GOLDEN_OUTPUT.roles[0],
                highlights: [GOLDEN_OUTPUT.roles[0].highlights[1], GOLDEN_OUTPUT.roles[0].highlights[0]],
            },
            GOLDEN_OUTPUT.roles[1],
        ],
    },
};
