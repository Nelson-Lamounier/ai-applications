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
 * phrase -- `scoreExperienceCoverage`'s term-tolerant path (`experienceTermMatch`)
 * credits it on discriminating terms {aws, database} alone, deliberately
 * WITHOUT relying on an anchor citation.
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
 * Task 3 term-rule v2 promotions -- the same three LIVE/REGRESSION cases
 * `experienceTermMatch` exercises at the raw-predicate level in
 * ats/gate/__tests__/experience-coverage.test.ts, carried verbatim into full
 * grader-level ExperienceEvalInput fixtures (same pattern as
 * `LINUX_ANCHORED_LIVE` above). Each is a single-role, single-line, zero-anchor
 * career/output pair so provenance is trivially satisfied and only the
 * term-tolerant coverage path is exercised.
 */
const MISSION_CRITICAL_DB_TEXT = 'Owned production database performance, tuning PostgreSQL and Aurora RDS '
    + 'clusters that processed over 10 million transactions daily.';
const MISSION_CRITICAL_DB_CAREER_ENTRIES: CareerEntry[] = [
    { title: 'Support Engineer', company: 'AWS', period: '2023-2025', highlights: [MISSION_CRITICAL_DB_TEXT] },
];
const MISSION_CRITICAL_DB_LINES = indexCareerLines(MISSION_CRITICAL_DB_CAREER_ENTRIES);
const MISSION_CRITICAL_DB_ROSTER = rosterFromCareer(MISSION_CRITICAL_DB_CAREER_ENTRIES);
const MISSION_CRITICAL_DB_TARGET: ExperienceAtsTarget = {
    skill: 'mission-critical production database systems',
    source: 'hard',
    verdict: 'verified',
    requirement: 'mission-critical production database systems',
    anchors: [], // deliberately empty -- proves emphasis-token stripping alone covers this
};

/** Covered: emphasis tokens {mission, critical} strip out of the target, leaving
 *  {production, database}, which the bullet demonstrates without ever saying
 *  "mission" or "critical". */
export const MISSION_CRITICAL_DB: ExperienceEvalInput = {
    output: {
        roles: [{
            company: 'AWS',
            title: 'Support Engineer',
            period: '2023-2025',
            highlights: [{ text: MISSION_CRITICAL_DB_TEXT, sources: [MISSION_CRITICAL_DB_LINES[0]!.id], atsTargets: ['mission-critical production database systems'] }],
        }],
        accounting: { dropped: [] },
    },
    roster: MISSION_CRITICAL_DB_ROSTER,
    careerLines: MISSION_CRITICAL_DB_LINES,
    atsTargets: [MISSION_CRITICAL_DB_TARGET],
    allowedNumbers: [],
};

const CODE_SCRIPTING_TEXT = 'Read legacy JavaScript code and wrote scripting utilities for the build pipeline.';
const CODE_SCRIPTING_CAREER_ENTRIES: CareerEntry[] = [
    { title: 'Support Engineer', company: 'AWS', period: '2023-2025', highlights: [CODE_SCRIPTING_TEXT] },
];
const CODE_SCRIPTING_LINES = indexCareerLines(CODE_SCRIPTING_CAREER_ENTRIES);
const CODE_SCRIPTING_ROSTER = rosterFromCareer(CODE_SCRIPTING_CAREER_ENTRIES);
const CODE_SCRIPTING_TARGET: ExperienceAtsTarget = {
    skill: 'code reading and scripting',
    source: 'hard',
    verdict: 'verified',
    requirement: 'code reading and scripting',
    anchors: [],
};

/** Covered via the language cue: the bullet names a real language (JavaScript)
 *  and demonstrates reading/scripting work, so `lightStem` bridging
 *  "reading"->"read" and "scripting"->"script" plus `matchTier1` proximity over
 *  {code, read, script} covers the target honestly. */
export const CODE_SCRIPTING: ExperienceEvalInput = {
    output: {
        roles: [{
            company: 'AWS',
            title: 'Support Engineer',
            period: '2023-2025',
            highlights: [{ text: CODE_SCRIPTING_TEXT, sources: [CODE_SCRIPTING_LINES[0]!.id], atsTargets: ['code reading and scripting'] }],
        }],
        accounting: { dropped: [] },
    },
    roster: CODE_SCRIPTING_ROSTER,
    careerLines: CODE_SCRIPTING_LINES,
    atsTargets: [CODE_SCRIPTING_TARGET],
    allowedNumbers: [],
};

const ENUMERATION_SCRIPTING_TARGET: ExperienceAtsTarget = {
    skill: 'scripting (Python, Java, JavaScript, Go, etc.)',
    source: 'hard',
    verdict: 'verified',
    requirement: 'scripting (Python, Java, JavaScript, Go, etc.)',
    anchors: [], // deliberately empty -- proves the enumeration rule alone covers this
};

/** Covered via the G2 enumeration rule: the bullet names JavaScript, one
 *  member of the parenthetical list, so `experienceTermMatch` credits the
 *  base requirement ("scripting") without demanding every listed language
 *  appear in the same bullet -- reuses the CODE_SCRIPTING career line above. */
export const ENUMERATION_SCRIPTING: ExperienceEvalInput = {
    output: {
        roles: [{
            company: 'AWS',
            title: 'Support Engineer',
            period: '2023-2025',
            highlights: [{ text: CODE_SCRIPTING_TEXT, sources: [CODE_SCRIPTING_LINES[0]!.id], atsTargets: ['scripting (Python, Java, JavaScript, Go, etc.)'] }],
        }],
        accounting: { dropped: [] },
    },
    roster: CODE_SCRIPTING_ROSTER,
    careerLines: CODE_SCRIPTING_LINES,
    atsTargets: [ENUMERATION_SCRIPTING_TARGET],
    allowedNumbers: [],
};

const RAPID_LEARNING_TEXT = 'Regularly worked through self-guided coursework and personal projects to stay '
    + 'current with new tools.';
const RAPID_LEARNING_CAREER_ENTRIES: CareerEntry[] = [
    { title: 'Support Engineer', company: 'AWS', period: '2023-2025', highlights: [RAPID_LEARNING_TEXT] },
];
const RAPID_LEARNING_LINES = indexCareerLines(RAPID_LEARNING_CAREER_ENTRIES);
const RAPID_LEARNING_ROSTER = rosterFromCareer(RAPID_LEARNING_CAREER_ENTRIES);
const RAPID_LEARNING_TARGET: ExperienceAtsTarget = {
    skill: 'rapid technical learning',
    source: 'hard',
    verdict: 'verified',
    requirement: 'rapid technical learning',
    anchors: [],
};

/** Stays missing -- honest synonym gap: "rapid" strips as emphasis, but the
 *  self-training bullet never names "technical" or "learn(ing)", so the
 *  term-tolerant path correctly declines to credit it. */
export const RAPID_LEARNING: ExperienceEvalInput = {
    output: {
        roles: [{
            company: 'AWS',
            title: 'Support Engineer',
            period: '2023-2025',
            highlights: [{ text: RAPID_LEARNING_TEXT, sources: [RAPID_LEARNING_LINES[0]!.id], atsTargets: [] }],
        }],
        accounting: { dropped: [] },
    },
    roster: RAPID_LEARNING_ROSTER,
    careerLines: RAPID_LEARNING_LINES,
    atsTargets: [RAPID_LEARNING_TARGET],
    allowedNumbers: [],
};

/**
 * Echo-cleanup eval case (review finding B, T4 tail): the jd-echo routed
 * re-write must rephrase a flagged bullet using ONLY the career lines
 * already cited for it -- these fixtures share one career/roster/atsTargets
 * context and vary only the bullet the routed re-write produced.
 * `ECHO_CLEANUP_FLAGGED_DETAIL` is the advisory string `routeExperienceRepairs`
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

/**
 * Verb-alignment eval cases (Task 2's `checkVerbAlignment`, promoted to
 * grader-level ExperienceEvalInput). `VERB_UPGRADE` is the guard's core case
 * (assisted-only citation, no cited line supports the stronger lead verb);
 * `VERB_LEGITIMISED` is the live run 1eda06eb shape carried over from
 * verb-alignment.test.ts's "is compliant when ANY cited line supports the lead
 * verb" case -- both career lines are cited by the same bullet and the SECOND
 * one genuinely supports "Owned".
 */
const VERB_UPGRADE_CAREER_ENTRIES: CareerEntry[] = [
    // "handling" deliberately avoids every VERB_TIERS lexicon hit -- "triage"
    // here would coincidentally raise the ceiling to tier 2 and dilute the
    // zero-support scenario this fixture exists to prove.
    { title: 'Support Engineer', company: 'AWS', period: '2023-2025', highlights: ['Assisted senior engineers with Sev-2 escalation handling'] },
];
const VERB_UPGRADE_LINES = indexCareerLines(VERB_UPGRADE_CAREER_ENTRIES);
const VERB_UPGRADE_ROSTER = rosterFromCareer(VERB_UPGRADE_CAREER_ENTRIES);

/** Assisted-only citation: the lead verb "Owned" (tier 3) cites ONLY a
 *  tier-1 "Assisted" line whose text names no other lexicon verb, so the
 *  computed ceiling is exactly 1 -- `checkVerbAlignment` finds it (tier 3 >
 *  ceiling 1) and `verbAlignmentGrader` rejects the output. Provenance,
 *  fabrication, coverage and reorder are all otherwise clean, so this fixture
 *  fails ONLY on verb alignment. */
export const VERB_UPGRADE: ExperienceEvalInput = {
    output: {
        roles: [{
            company: 'AWS',
            title: 'Support Engineer',
            period: '2023-2025',
            highlights: [{ text: 'Owned end-to-end resolution of complex customer escalations', sources: [VERB_UPGRADE_LINES[0]!.id], atsTargets: [] }],
        }],
        accounting: { dropped: [] },
    },
    roster: VERB_UPGRADE_ROSTER,
    careerLines: VERB_UPGRADE_LINES,
    atsTargets: [],
    allowedNumbers: [],
};

const VERB_LEGITIMISED_CAREER_ENTRIES: CareerEntry[] = [
    {
        title: 'Support Engineer',
        company: 'AWS',
        period: '2023-2025',
        highlights: [
            'Assisted senior engineers with Sev-2 escalations',
            'Took ownership of customer cases -- own cases end-to-end from triage to resolution',
        ],
    },
];
const VERB_LEGITIMISED_LINES = indexCareerLines(VERB_LEGITIMISED_CAREER_ENTRIES);
const VERB_LEGITIMISED_ROSTER = rosterFromCareer(VERB_LEGITIMISED_CAREER_ENTRIES);

/** Live two-citation case: the lead bullet cites BOTH lines -- the first is
 *  only tier 1, but the second ("own cases end-to-end") genuinely supports
 *  tier 3, so the any-cited-line ceiling is compliant. A second, low-tier
 *  bullet citing the "Assisted" line satisfies the role's min-2-bullet
 *  provenance rule without introducing a verb finding of its own -- the whole
 *  fixture is clean end to end. */
export const VERB_LEGITIMISED: ExperienceEvalInput = {
    output: {
        roles: [{
            company: 'AWS',
            title: 'Support Engineer',
            period: '2023-2025',
            highlights: [
                {
                    text: 'Owned end-to-end technical resolution of complex customer issues',
                    sources: [VERB_LEGITIMISED_LINES[0]!.id, VERB_LEGITIMISED_LINES[1]!.id],
                    atsTargets: [],
                },
                {
                    text: 'Assisted senior engineers with recurring Sev-2 escalation triage',
                    sources: [VERB_LEGITIMISED_LINES[0]!.id],
                    atsTargets: [],
                },
            ],
        }],
        accounting: { dropped: [] },
    },
    roster: VERB_LEGITIMISED_ROSTER,
    careerLines: VERB_LEGITIMISED_LINES,
    atsTargets: [],
    allowedNumbers: [],
};
