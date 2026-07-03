/** @format */
/**
 * Summary attribution guards — regression fixtures from the Accenture DevOps
 * run d4aae717 (2026-07-03) whose summary (a) welded the AWS employer anchor
 * to the solo Tucaken bridge in one predicate chain, (b) re-used the JD
 * companyProblem's "cross-functional teams … bottleneck" phrasing as the
 * candidate's own identity claim, and (c) shipped an unattributed, invented
 * "The problem:" sentence.
 */
jest.mock('@bedrock/shared', () => ({
    ...jest.requireActual('@bedrock/shared'),
    runAgent: jest.fn(),
    log: () => undefined,
}));
import {
    validateResume,
    summaryConflationSentences,
    identityProblemPhrases,
    unattributedBridgeSentence,
} from './resume-guard.js';
import type { ResumeGuardCtx } from './resume-guard.js';
import type { StructuredResumeData } from '@bedrock/shared';

const COMPANY_PROBLEM =
    'The Dock needs to build and scale a reliable, secure engineering platform that supports ' +
    'cross-functional teams (engineers, architects, data scientists, product) delivering ' +
    'production-ready cloud-native solutions. The role exists to own and evolve the foundational ' +
    'infrastructure layer, CI/CD, cloud environments, containerisation, observability, and security, ' +
    'so that product delivery is fast, repeatable, and resilient without that layer becoming a ' +
    'bottleneck or liability.';

/** The exact summary the run shipped. */
const RUN_SUMMARY =
    'DevOps and platform engineer who builds foundational infrastructure, CI/CD, Kubernetes, IaC, ' +
    'observability, and security-by-design so cross-functional teams ship reliably without the ' +
    'platform becoming a bottleneck. The problem: teams manually patch security posture, lack ' +
    'visibility into cluster health and deployment velocity, and burn weeks optimizing infrastructure ' +
    'after incident triage. At AWS I triaged production failures; building Tucaken, I eliminated the ' +
    'friction, policy-as-code gates deployments, GitOps auto-reconciles infrastructure, observability ' +
    'surfaces real-time DORA metrics, and every change is tested and scanned before production.';

const base = (summary: string): StructuredResumeData => ({
    profile: { name: 'Nelson', title: 'Cloud & DevOps Platforms · IaC & Observability', email: 'e', location: 'Dublin' },
    summary,
    experience: [{ company: 'Amazon Web Services (AWS)', title: 'Technical Customer Service Associate', period: '2022 - Present', highlights: ['Resolved customer escalations across IAM and ECS'] }],
    skills: [{ category: 'Cloud', skills: ['AWS'] }],
    education: [{ degree: 'Higher Diploma in Computing', institution: 'DBS', period: '2022-2024' }],
    certifications: [], projects: [], keyAchievements: [],
    sectionOrder: ['summary', 'experience', 'projects', 'education', 'skills', 'certifications'],
} as StructuredResumeData);

const ctx: ResumeGuardCtx = {
    targetRole: 'DevOps Engineer',
    leadIdentity: 'DevOps and platform engineer who builds foundational infrastructure',
    verifiedEducation: ['Higher Diploma in Computing'],
    archetypeSkillLead: '',
    companyProblem: COMPANY_PROBLEM,
    targetCompany: 'Accenture',
    projectPitches: [{ name: 'Tucaken', pitch: 'AI-assisted job application platform' }],
    verifiedEmployers: [
        { name: 'Amazon Web Services (AWS)', facts: 'Resolved customer escalations across IAM policy documents and ECS deployment failures' },
        { name: 'Meta via Accenture', facts: 'Quality assurance analysis of content workflows' },
    ],
};

const codes = (summary: string) => validateResume(base(summary), ctx).map((v) => v.code);

describe('summary_employer_project_conflation', () => {
    it('flags the run summary — AWS anchor and Tucaken bridge welded into one sentence', () => {
        const sentences = summaryConflationSentences(base(RUN_SUMMARY), ctx);
        expect(sentences).toHaveLength(1);
        expect(sentences[0]).toContain('At AWS I triaged');
        expect(codes(RUN_SUMMARY)).toContain('summary_employer_project_conflation');
    });

    it('passes when employer anchor and solo-project bridge are separate sentences', () => {
        const fixed =
            'At AWS I support customers through production incidents across IAM and ECS. ' +
            'Solo-building Tucaken, policy-as-code gates every deployment and GitOps reconciles the infrastructure.';
        expect(summaryConflationSentences(base(fixed), ctx)).toHaveLength(0);
    });

    it('matches the parenthetical short form (AWS) via word boundary, not substring', () => {
        const flawed = 'Fixing flaws in Tucaken taught me rigour.';
        expect(summaryConflationSentences(base(flawed), ctx)).toHaveLength(0);
    });
});

describe('summary_identity_echoes_problem', () => {
    it('flags the run summary — identity sentence re-uses companyProblem phrases', () => {
        const phrases = identityProblemPhrases(base(RUN_SUMMARY), COMPANY_PROBLEM);
        expect(phrases).toContain('cross-functional teams');
        expect(codes(RUN_SUMMARY)).toContain('summary_identity_echoes_problem');
    });

    it('passes an identity sentence in the candidate own vocabulary', () => {
        const clean =
            'DevOps engineer who designs, ships, and operates cloud platforms end to end as a solo builder. ' +
            'Accenture needs a foundational layer that supports cross-functional teams without becoming a bottleneck.';
        expect(identityProblemPhrases(base(clean), COMPANY_PROBLEM)).toHaveLength(0);
    });

    it('no companyProblem → no check', () => {
        expect(identityProblemPhrases(base(RUN_SUMMARY), undefined)).toHaveLength(0);
    });
});

describe('summary_problem_bridge_unattributed', () => {
    it('flags the run summary — "The problem:" sentence has no company/role attribution', () => {
        const bridge = unattributedBridgeSentence(base(RUN_SUMMARY), ctx);
        expect(bridge).toContain('The problem:');
        expect(codes(RUN_SUMMARY)).toContain('summary_problem_bridge_unattributed');
    });

    it('passes a bridge attributed to the company by name', () => {
        const attributed =
            'Solo DevOps builder shipping production platforms. ' +
            'Accenture needs a secure, repeatable delivery layer so product teams stay fast, and that is the platform shape I build.';
        expect(unattributedBridgeSentence(base(attributed), ctx)).toBeNull();
    });

    it('passes a bridge attributed via "this role exists to"', () => {
        const attributed =
            'Solo DevOps builder shipping production platforms. ' +
            'This role exists to own the foundational delivery layer, cloud environments and observability, so delivery stays repeatable.';
        expect(unattributedBridgeSentence(base(attributed), ctx)).toBeNull();
    });

    it('ignores summaries whose later sentences never draw on the problem (bridge-missing is a separate code)', () => {
        const noBridge = 'Solo DevOps builder shipping production platforms. I automate everything twice.';
        expect(unattributedBridgeSentence(base(noBridge), ctx)).toBeNull();
    });
});
