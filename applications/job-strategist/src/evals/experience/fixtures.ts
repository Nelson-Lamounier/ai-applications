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
    { skill: 'DNS', source: 'hard', verdict: 'verified', requirement: NETWORKING_REQUIREMENT, anchors: [] },
    { skill: 'TCP/IP', source: 'hard', verdict: 'verified', requirement: NETWORKING_REQUIREMENT, anchors: [] },
    { skill: 'SSL/TLS', source: 'hard', verdict: 'transferable', requirement: NETWORKING_REQUIREMENT, anchors: [] },
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

/**
 * Spec case 1 -- anchored, verbatim from the live run (a7356cc5): the exact
 * bullet text `selectExperienceAtsTargets` produced against a "Linux systems
 * engineering" (source=disqualifying, verdict=verified) target, carried
 * verbatim from the ats/gate/experience-coverage.test.ts "LIVE RUN CASE 1"
 * unit fixture into a full grader-level ExperienceEvalInput. `anchors` is
 * populated (as `selectExperienceAtsTargets` would compute it) so this
 * exercises the anchor-citation path end to end through every structural
 * grader, not just the raw scorer.
 */
const LINUX_CAREER_ENTRIES: CareerEntry[] = [
    {
        title: 'Support Engineer',
        company: 'AWS',
        period: '2023-2025',
        highlights: [
            'Guided customers through Amazon Linux (AL2 and AL2023) system setup and configuration on EC2, '
                + 'covering instance provisioning, SSH access and key management, package and systemd service '
                + 'configuration, and OS-level troubleshooting of boot, storage, and network connectivity issues.',
        ],
    },
];
const LINUX_LINES = indexCareerLines(LINUX_CAREER_ENTRIES);
const LINUX_ROSTER = rosterFromCareer(LINUX_CAREER_ENTRIES);
const LINUX_TARGET: ExperienceAtsTarget = {
    skill: 'Linux systems engineering',
    source: 'disqualifying',
    verdict: 'verified',
    requirement: 'Linux systems engineering and administration',
    anchors: [LINUX_LINES[0]!.id],
};

export const LINUX_ANCHORED_LIVE: ExperienceEvalInput = {
    output: {
        roles: [
            {
                company: 'AWS',
                title: 'Support Engineer',
                period: '2023-2025',
                highlights: [{ text: LINUX_CAREER_ENTRIES[0]!.highlights[0]!, sources: [LINUX_LINES[0]!.id], atsTargets: ['Linux systems engineering'] }],
            },
        ],
        accounting: { dropped: [] },
    },
    roster: LINUX_ROSTER,
    careerLines: LINUX_LINES,
    atsTargets: [LINUX_TARGET],
    allowedNumbers: [],
};

/**
 * Spec case 2 -- term-tolerant: the target has ZERO anchors (the selection
 * step found no career line that already names it), yet the rewritten bullet
 * honestly demonstrates the skill in the JD's vocabulary without the exact
 * phrase -- `scoreExperienceCoverage`'s term-tolerant path (`requiredTerms`/
 * `matchesAllTerms`) credits it on discriminating terms {aws, database}
 * alone, deliberately WITHOUT relying on an anchor citation.
 */
const AWS_DB_CAREER_ENTRIES: CareerEntry[] = [
    {
        title: 'Support Engineer',
        company: 'AWS',
        period: '2023-2025',
        highlights: [
            'Resolved AWS database connectivity and performance issues across RDS and Aurora, including '
                + 'parameter and security-group misconfiguration, storage and performance tuning, and backup, '
                + 'restore and failover troubleshooting.',
        ],
    },
];
const AWS_DB_LINES = indexCareerLines(AWS_DB_CAREER_ENTRIES);
const AWS_DB_ROSTER = rosterFromCareer(AWS_DB_CAREER_ENTRIES);
const AWS_DB_TARGET: ExperienceAtsTarget = {
    skill: 'AWS database systems',
    source: 'hard',
    verdict: 'verified',
    requirement: 'AWS database systems support',
    anchors: [], // deliberately empty -- proves the term-tolerant path alone covers this
};

export const TERM_TOLERANT_AWS_DB: ExperienceEvalInput = {
    output: {
        roles: [
            {
                company: 'AWS',
                title: 'Support Engineer',
                period: '2023-2025',
                highlights: [{
                    text: 'Troubleshot AWS database connectivity, working RDS and Aurora storage and failover issues '
                        + 'end to end',
                    sources: [AWS_DB_LINES[0]!.id],
                    atsTargets: ['AWS database systems'],
                }],
            },
        ],
        accounting: { dropped: [] },
    },
    roster: AWS_DB_ROSTER,
    careerLines: AWS_DB_LINES,
    atsTargets: [AWS_DB_TARGET],
    allowedNumbers: [],
};

/**
 * Spec case 3 -- no-evidence target stays missing (fail-closed): the target
 * has zero anchors AND no bullet's text contains every one of its
 * discriminating terms -- `scoreExperienceCoverage` must never vacuously
 * cover it. Career history and bullets are genuinely unrelated to the target.
 */
const GAP_CAREER_ENTRIES: CareerEntry[] = [
    { title: 'QA Analyst', company: 'Acme', period: '2021-2023', highlights: ['Automated regression suites gating nightly releases'] },
];
const GAP_LINES = indexCareerLines(GAP_CAREER_ENTRIES);
const GAP_ROSTER = rosterFromCareer(GAP_CAREER_ENTRIES);
const GAP_TARGET: ExperienceAtsTarget = {
    skill: 'Distributed systems design',
    source: 'hard',
    verdict: 'verified',
    requirement: 'Distributed systems design',
    anchors: [],
};

export const NO_EVIDENCE_MISSING: ExperienceEvalInput = {
    output: {
        roles: [{
            company: 'Acme',
            title: 'QA Analyst',
            period: '2021-2023',
            highlights: [{ text: 'Automated regression suites gating nightly releases', sources: [GAP_LINES[0]!.id], atsTargets: [] }],
        }],
        accounting: { dropped: [] },
    },
    roster: GAP_ROSTER,
    careerLines: GAP_LINES,
    atsTargets: [GAP_TARGET],
    allowedNumbers: [],
};

/**
 * Echo-cleanup eval case (review finding B, T4 tail): the jd-echo routed
 * re-write must rephrase a flagged bullet using ONLY the career lines
 * already cited for it -- these fixtures share one career/roster/atsTargets
 * context and vary only the bullet the routed re-write produced.
 * `ECHO_CLEANUP_FLAGGED_DETAIL` is the advisory string `routeJdEchoRewrite`
 * hands to `ExperienceMessageInput.echoCleanup.flaggedDetails`.
 */
const ECHO_CAREER_ENTRIES: CareerEntry[] = [
    {
        title: 'Support Engineer',
        company: 'AWS',
        period: '2023-2025',
        highlights: [
            'Applied DNS resolution troubleshooting for customer VPC configurations',
            'Resolved elevated escalations with customer security teams',
        ],
    },
];
const ECHO_LINES = indexCareerLines(ECHO_CAREER_ENTRIES);
const ECHO_ROSTER = rosterFromCareer(ECHO_CAREER_ENTRIES);

export const ECHO_CLEANUP_FLAGGED_DETAIL = 'AWS: "Spearheaded enterprise-grade DNS resolution architecture leveraging '
    + 'cutting-edge cloud-native paradigms" leans on JD vocabulary (enterprise-grade, cutting-edge, cloud-native '
    + 'paradigms) absent from this role\'s verified facts.';

/** Provenance-clean: the rephrase drops the JD-echo wording but keeps citing
 *  the SAME career lines the flagged bullet already had. */
export const ECHO_CLEANUP_VALID: ExperienceEvalInput = {
    output: {
        roles: [{
            company: 'AWS',
            title: 'Support Engineer',
            period: '2023-2025',
            highlights: [
                { text: 'Applied DNS resolution troubleshooting for customer VPC configurations', sources: [ECHO_LINES[0]!.id], atsTargets: [] },
                { text: 'Resolved elevated escalations with customer security teams', sources: [ECHO_LINES[1]!.id], atsTargets: [] },
            ],
        }],
        accounting: { dropped: [] },
    },
    roster: ECHO_ROSTER,
    careerLines: ECHO_LINES,
    atsTargets: [],
    allowedNumbers: [],
};

/** Provenance-invalid: the rephrase cites a career line it did not have --
 *  `c0.h9` does not exist in `ECHO_LINES`, so the citation is fabricated;
 *  `c0.h0` is left neither cited nor dropped. Must be rejected. */
export const ECHO_CLEANUP_INVALID: ExperienceEvalInput = {
    ...ECHO_CLEANUP_VALID,
    output: {
        roles: [{
            company: 'AWS',
            title: 'Support Engineer',
            period: '2023-2025',
            highlights: [
                { text: 'Delivered enterprise-grade DNS architecture at scale', sources: ['c0.h9'], atsTargets: [] },
                { text: 'Resolved elevated escalations with customer security teams', sources: [ECHO_LINES[1]!.id], atsTargets: [] },
            ],
        }],
        accounting: { dropped: [] },
    },
};
