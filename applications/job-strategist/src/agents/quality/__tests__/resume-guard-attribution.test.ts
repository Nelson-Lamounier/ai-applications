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
    preserveExperienceRoster,
    summaryConflationSentences,
    identityProblemPhrases,
    jobDescribingSentences,
    targetCompanySentences,
    stripJobDescribingSentences,
    stripIdentityProblemClause,
} from '../resume-guard.js';
import type { ResumeGuardCtx } from '../resume-guard.js';
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

/** The exact bridge sentence the Mater run (f133155f) shipped — mission recitation. */
const MATER_SENTENCE =
    'This role exists to expand Mater Private Network\'s IT capacity to deliver clinical and ' +
    'patient-facing systems navigating compliance and healthcare interoperability constraints.';

const materCtx: ResumeGuardCtx = {
    ...ctx,
    targetCompany: 'The Mater Private Network',
    companyProblem:
        'Mater Private Network needs to build and maintain secure, scalable digital applications ' +
        'across clinical and patient-facing healthcare systems in a complex, regulated environment.',
};

describe('summary_describes_job (inverse of the removed bridge-attribution rule)', () => {
    it('flags the Mater run sentence — "This role exists to…" describes the job, not the candidate', () => {
        const flagged = jobDescribingSentences(base('Full-stack TypeScript practitioner who ships tested applications. ' + MATER_SENTENCE));
        expect(flagged).toHaveLength(1);
        expect(flagged[0]).toContain('This role exists to');
    });

    it('flags the d4aae717 "The problem:" label too', () => {
        expect(codes(RUN_SUMMARY)).toContain('summary_describes_job');
    });

    it('passes a candidate-voice bridge (capability-level relevance, no job description)', () => {
        const clean =
            'Full-stack TypeScript practitioner who ships tested, security-hardened applications. ' +
            'Applies policy-as-code and automated compliance testing, the delivery discipline regulated environments demand.';
        expect(jobDescribingSentences(base(clean))).toHaveLength(0);
    });
});

describe('summary_names_target_company', () => {
    it('flags the Mater sentence — target company named in the summary', () => {
        const flagged = targetCompanySentences(base(MATER_SENTENCE), materCtx);
        expect(flagged).toHaveLength(1);
        expect(validateResume(base(MATER_SENTENCE), materCtx).map((v) => v.code)).toContain('summary_names_target_company');
    });

    it('does NOT flag a target name that is also a verified employer (Accenture via Meta)', () => {
        const anchor = 'At Meta via Accenture I ran QA analysis for content workflows.';
        expect(targetCompanySentences(base(anchor), ctx)).toHaveLength(0);
    });
});

describe('deterministic strips (backstops after the bounded repair)', () => {
    it('stripJobDescribingSentences deletes the Mater sentence and keeps the rest', () => {
        const seen: string[] = [];
        const out = stripJobDescribingSentences(
            base('Full-stack TypeScript practitioner who ships tested applications. ' + MATER_SENTENCE + ' AWS Certified DevOps Engineer.'),
            materCtx,
            (v) => seen.push(v.code),
        );
        expect(out.summary).toBe('Full-stack TypeScript practitioner who ships tested applications. AWS Certified DevOps Engineer.');
        expect(seen).toEqual(['summary_job_sentence_stripped']);
    });

    it('stripIdentityProblemClause removes the leaked clause from run 1f1bd3c2 shape', () => {
        const seen: string[] = [];
        const out = stripIdentityProblemClause(
            base('DevOps/platform engineer who designs and operates IaC, CI/CD, Kubernetes, and DevSecOps foundations for cross-functional teams. Second sentence stays.'),
            COMPANY_PROBLEM,
            (v) => seen.push(v.code),
        );
        expect(out.summary).toContain('DevSecOps foundations.');
        expect(out.summary).not.toContain('cross-functional');
        expect(out.summary).toContain('Second sentence stays.');
        expect(seen).toEqual(['summary_identity_clause_stripped']);
    });

    it('both strips are no-ops on a clean summary', () => {
        const clean = base('Full-stack practitioner who ships tested applications. Applies policy-as-code discipline.');
        expect(stripJobDescribingSentences(clean, materCtx)).toBe(clean);
        expect(stripIdentityProblemClause(clean, COMPANY_PROBLEM)).toBe(clean);
    });
});

describe('preserveExperienceRoster', () => {
    const roles = [
        { company: 'Amazon Web Services (AWS)', title: 'Technical Customer Service Associate', period: '2022 - Present', highlights: ['a'] },
        { company: 'Solo-built production SaaS platform (Tucaken)', title: 'Cloud & DevOps Engineer', period: '2022 - Present', highlights: ['b'] },
        { company: 'Meta via Accenture', title: 'Quality Assurance Analyst', period: '2021 - 2022', highlights: ['c'] },
    ];
    const withRoles = (experience: typeof roles) => ({ ...base('s'), experience }) as StructuredResumeData;

    it('reinserts a dropped role at its original index (run 8830a239 regression: Meta vanished)', () => {
        const seen: string[] = [];
        const out = preserveExperienceRoster(
            withRoles(roles),
            withRoles([roles[0], roles[1]] as typeof roles),
            (v) => seen.push(v.code),
        );
        expect(out.experience.map((e) => e.company)).toEqual(roles.map((r) => r.company));
        expect(seen).toEqual(['experience_role_dropped']);
    });

    it('tolerates a company relabel (solo framing) — no duplicate reinsertion', () => {
        const relabelled = [roles[0], { ...roles[1], company: 'Tucaken (SaaS Platform)' }, roles[2]] as typeof roles;
        const out = preserveExperienceRoster(withRoles(roles), withRoles(relabelled));
        expect(out.experience).toHaveLength(3);
        expect(out.experience[1].company).toBe('Tucaken (SaaS Platform)');
    });

    it('no-op when the roster is intact', () => {
        const after = withRoles(roles);
        expect(preserveExperienceRoster(withRoles(roles), after)).toBe(after);
    });
});
