/** @format */
jest.mock('@bedrock/shared', () => ({
    ...jest.requireActual('@bedrock/shared'),
    runAgent: jest.fn(),
    log: () => undefined,
}));
import { runAgent } from '@bedrock/shared';
import { guardResume, validateResume, enforceScopedClaims, dropKeyAchievementsSection, summarySharedNumbers, enforceProhibitedClaims, revalidateResumeContent, summaryEchoSentences, enforceCertYears, checkProjectPitchAlignment, checkBulletJdEcho } from './resume-guard.js';
import type { StructuredResumeData } from '@bedrock/shared';

const mockRun = runAgent as jest.Mock;

const base = (over: Partial<StructuredResumeData> = {}): StructuredResumeData => ({
    profile: { name: 'Nelson', title: 'Cloud & AI Operations · Python Automation', email: 'e', location: 'Dublin' },
    summary: 'Ships production AI and applies root-cause methodology to support escalations. 5 years across support and operations.',
    experience: [{ company: 'AWS', title: 'Technical Customer Service Associate', period: '2022 - Present', highlights: ['Removed 10-20 hrs/week toil via automation'] }],
    skills: [{ category: 'Support & Troubleshooting', skills: ['root-cause analysis', 'SLA'] }, { category: 'Cloud', skills: ['AWS'] }],
    education: [{ degree: 'Higher Diploma in Computing', institution: 'DBS', period: '2022-2024' }],
    certifications: [], projects: [], keyAchievements: [],
    sectionOrder: ['summary', 'experience', 'projects', 'education', 'skills', 'certifications'],
    ...over,
} as StructuredResumeData);

const ctx = { targetRole: 'AI Support Engineer', leadIdentity: 'Support engineer who builds production AI', verifiedEducation: ['Higher Diploma in Computing'], archetypeSkillLead: 'Support & Troubleshooting' };
const codes = (r: StructuredResumeData) => validateResume(r, ctx).map((v) => v.code);

describe('validateResume', () => {
    it('clean resume → no violations', () => { expect(codes(base())).toEqual([]); });
    it('headline_is_title — title is a verbatim employment title / no positioning separator', () => {
        expect(codes(base({ profile: { name: 'N', title: 'Technical Customer Service Associate', email: 'e', location: 'D' } }))).toContain('headline_is_title');
    });
    it('headline_is_title — lead segment contains a job-title noun even with a separator', () => {
        expect(codes(base({ profile: { name: 'N', title: 'Support Engineer · Cloud & AI Operations', email: 'e', location: 'D' } }))).toContain('headline_is_title');
    });
    it('no headline_is_title — descriptive domain/capability headline with no job-title noun', () => {
        expect(codes(base({ profile: { name: 'N', title: 'Cloud & AI Operations · Python Automation', email: 'e', location: 'D' } }))).not.toContain('headline_is_title');
    });
    it('selected_work_misplaced — Selected-work/GitHub line under a support/customer role', () => {
        const r = base({ experience: [{ company: 'AWS', title: 'Technical Customer Service Associate', period: '2022 - Present', highlights: ['Resolved escalations', 'Selected work: github.com/Nelson-Lamounier/x'] }] });
        expect(codes(r)).toContain('selected_work_misplaced');
    });
    it('no selected_work_misplaced — same Selected-work line under a builder/engineering role', () => {
        const r = base({ experience: [{ company: 'Freelance', title: 'Cloud & DevOps Engineer', period: '2022 - Present', highlights: ['Built CDK pipelines', 'Selected work: github.com/Nelson-Lamounier/x'] }] });
        expect(codes(r)).not.toContain('selected_work_misplaced');
    });
    it('summary_wrong_cluster — first sentence lacks the leadIdentity head noun', () => {
        expect(codes(base({ summary: 'Cloud infrastructure engineer with 3+ years triaging AWS escalations.' }))).toContain('summary_wrong_cluster');
    });
    it('summary_names_gap — raw years-gap / self-deprecation', () => {
        expect(codes(base({ summary: 'Support engineer whose 3 years falls short of the 8-year requirement.' }))).toContain('summary_names_gap');
    });
    it('education_mismatch — a degree not in verifiedEducation', () => {
        expect(codes(base({ education: [{ degree: 'BA in Digital Marketing', institution: 'DBS', period: '2016-2020' }] }))).toContain('education_mismatch');
    });
    it('skills_lead_mismatch — first skill group is not the archetype lead', () => {
        expect(codes(base({ skills: [{ category: 'Cloud', skills: ['AWS'] }, { category: 'Support & Troubleshooting', skills: ['SLA'] }] }))).toContain('skills_lead_mismatch');
    });
});

describe('guardResume', () => {
    beforeEach(() => { mockRun.mockReset(); });

    it('clean resume → unchanged, no rewrite call', async () => {
        const r = base();
        const res = await guardResume(r, ctx);
        expect(res.resume).toStrictEqual(r);
        expect(res.violations).toEqual([]);
        expect(mockRun).not.toHaveBeenCalled();
    });
    it('violations → calls rewrite, returns fixed + original violations', async () => {
        const fixed = base();
        mockRun.mockResolvedValue({ data: fixed });
        const bad = base({ summary: 'Cloud infrastructure engineer with 3 years that falls short of the 8-year bar.' });
        const res = await guardResume(bad, ctx);
        expect(res.resume).toStrictEqual(fixed);
        expect(res.violations.map((v) => v.code)).toEqual(expect.arrayContaining(['summary_wrong_cluster', 'summary_names_gap']));
    });
    it('rewrite throws → returns ORIGINAL (fail-open)', async () => {
        mockRun.mockRejectedValue(new Error('down'));
        const bad = base({ summary: 'Cloud infrastructure engineer, 3 years, falls short.' });
        const res = await guardResume(bad, ctx);
        expect(res.resume).toStrictEqual(bad);
    });
    it('clean resume with em-dash in summary → em-dash replaced by comma, no rewrite call', async () => {
        const withDash = base({ summary: 'Support engineer who ships production AI — the biggest win. 5 years across support and operations.' });
        const res = await guardResume(withDash, ctx);
        expect(res.violations).toEqual([]);
        expect(mockRun).not.toHaveBeenCalled();
        expect(res.resume.summary).toBe('Support engineer who ships production AI, the biggest win. 5 years across support and operations.');
    });
});

describe('enforceScopedClaims', () => {
    it('strips the unqualified prompt-cache metric from a skills entry, keeping the skill', () => {
        const r = base({ skills: [{ category: 'Support & Troubleshooting', skills: ['prompt caching (~90% cost reduction)', 'RAG'] }] });
        const { resume, violations } = enforceScopedClaims(r);
        expect(resume.skills[0].skills).toEqual(['prompt caching', 'RAG']);
        expect(violations.map((v) => v.code)).toContain('scoped_claim_unqualified');
    });

    it('keeps a properly scoped skills entry untouched', () => {
        const r = base({ skills: [{ category: 'Support & Troubleshooting', skills: ['prompt caching (~90% cost reduction on the Writer Lambda)'] }] });
        const { resume, violations } = enforceScopedClaims(r);
        expect(resume.skills[0].skills[0]).toContain('Writer Lambda');
        expect(violations).toEqual([]);
    });

    it('qualifies (not strips) the metric in an experience highlight', () => {
        const r = base({ experience: [{ company: 'F', title: 'Cloud & DevOps Engineer', period: '2022 - Present', highlights: ['Applied prompt caching for a ~90% cost reduction on inference.'] }] });
        const { resume, violations } = enforceScopedClaims(r);
        expect(resume.experience[0].highlights[0]).toContain('(Writer Lambda)');
        expect(violations.map((v) => v.code)).toContain('scoped_claim_unqualified');
    });

    it('strips an unqualified metric sentence from the summary', () => {
        const r = base({ summary: 'Ships production AI systems. Achieved ~90% cost reduction via prompt caching.' });
        const { resume } = enforceScopedClaims(r);
        expect(resume.summary).toBe('Ships production AI systems.');
    });

    it('no scoped metric anywhere → no violations, resume unchanged', () => {
        const r = base();
        const { resume, violations } = enforceScopedClaims(r);
        expect(violations).toEqual([]);
        expect(resume).toStrictEqual(r);
    });
});

describe('dropKeyAchievementsSection', () => {
    it('drops an emitted keyAchievements section and scrubs sectionOrder', () => {
        const r = base({
            keyAchievements: [{ achievement: 'Cut costs 40%' }],
            sectionOrder: ['summary', 'keyAchievements', 'experience', 'skills'],
        } as never);
        const { resume, violations } = dropKeyAchievementsSection(r);
        expect((resume as { keyAchievements: unknown[] }).keyAchievements).toEqual([]);
        expect((resume as { sectionOrder: string[] }).sectionOrder).not.toContain('keyAchievements');
        expect(violations.map((v) => v.code)).toEqual(['key_achievements_emitted']);
    });

    it('empty keyAchievements → untouched, no violation', () => {
        const r = base();
        const { resume, violations } = dropKeyAchievementsSection(r);
        expect(resume).toBe(r);
        expect(violations).toEqual([]);
    });
});

describe('summary_restates_bullets', () => {
    it('flags a summary repeating two bullet numbers (inventory summary)', () => {
        const r = base({
            summary: 'Ships production AI systems. Built 16-stack monorepo with 30 custom rules. Closing metric: 25 ArgoCD apps.',
            experience: [{ company: 'F', title: 'Cloud & DevOps Engineer', period: '2022 - Present', highlights: [
                'Engineered 16-CDK-stack IaC monorepo across four accounts.',
                'Wrote 30 custom Checkov Python rules with a severity gate.',
                'Manages 25 ArgoCD applications.',
            ] }],
        });
        expect(codes(r)).toContain('summary_restates_bullets');
    });

    it('flags even a single bullet-shared number (the ladder rule: counts belong to bullets)', () => {
        const r = base({
            summary: 'Ships production AI and applies root-cause methodology to support escalations. Positioning prose without bullet facts. Closing metric: 25 ArgoCD apps.',
            experience: [{ company: 'F', title: 'Cloud & DevOps Engineer', period: '2022 - Present', highlights: [
                'Manages 25 ArgoCD applications with self-healing GitOps.',
            ] }],
        });
        expect(codes(r)).toContain('summary_restates_bullets');
    });

    it('a numberless altitude summary passes', () => {
        const r = base({
            summary: 'Platform engineer who builds and operates production Kubernetes on AWS end to end, backed by hands-on operational support experience. Every change is gated by automated tests and policy-as-code before production.',
            experience: [{ company: 'F', title: 'Cloud & DevOps Engineer', period: '2022 - Present', highlights: [
                'Manages 25 ArgoCD applications with self-healing GitOps.',
            ] }],
        });
        expect(codes(r)).not.toContain('summary_restates_bullets');
    });

    it('summarySharedNumbers strips separators and plus suffixes', () => {
        const r = base({
            summary: 'Ships systems with 265+ assertions. 5 years across support and operations.',
            experience: [{ company: 'F', title: 'E', period: 'p', highlights: ['Maintains 265 CDK test assertions.'] }],
        });
        expect(summarySharedNumbers(r)).toEqual(['265']);
    });
});

describe('project_restates_bullets', () => {
    it('flags a project description repeating two bullet numbers', () => {
        const r = base({
            projects: [{ name: 'AI Platform', github: '', description: '16-CDK-stack monorepo with ArgoCD GitOps managing 25 applications and Blue/Green rollouts.' }],
            experience: [{ company: 'F', title: 'Cloud & DevOps Engineer', period: '2022 - Present', highlights: [
                'Engineered 16-CDK-stack IaC monorepo across four accounts.',
                'Manages 25 ArgoCD applications with self-healing GitOps.',
            ] }],
        } as never);
        expect(codes(r)).toContain('project_restates_bullets');
    });

    it('allows a pitch-led description with one fresh metric and one shared number', () => {
        const r = base({
            projects: [{ name: 'AI Platform', github: '', description: 'SaaS for engineers seeking honest, code-grounded resumes. Differentiates via anti-fabrication guards; 38 KB passages ground each run across 25 applications.' }],
            experience: [{ company: 'F', title: 'Cloud & DevOps Engineer', period: '2022 - Present', highlights: [
                'Manages 25 ArgoCD applications with self-healing GitOps.',
            ] }],
        } as never);
        expect(codes(r)).not.toContain('project_restates_bullets');
    });
});

describe('enforceProhibitedClaims', () => {
    it('removes a flat Terraform mention from a skills item, keeps bridged ones', () => {
        const r = base({ skills: [{ category: 'Support & Troubleshooting', skills: ['IaC (CDK, Terraform, Bicep)', 'AWS CDK, transferable to Terraform'] }] });
        const { resume, violations } = enforceProhibitedClaims(r);
        expect(resume.skills[0].skills[0]).not.toMatch(/terraform/i);
        expect(resume.skills[0].skills[1]).toMatch(/transferable to Terraform/);
        expect(violations.map((v) => v.code)).toContain('prohibited_claim_fixed');
    });

    it('substitutes never-claimables in prose (service mesh, on-call)', () => {
        const r = base({ summary: 'Runs a service mesh with on-call rotations. Ships production AI systems.' });
        const { resume } = enforceProhibitedClaims(r);
        expect(resume.summary).toContain('Traefik v3 ingress');
        expect(resume.summary).toContain('solo-operated');
        expect(resume.summary).not.toMatch(/service mesh|on-call/i);
    });

    it('reports an unbridged prose mention for the bounded repair', () => {
        const r = base({ summary: 'IaC discipline spans CDK and Terraform pipelines. Ships production AI systems.' });
        const { violations } = enforceProhibitedClaims(r);
        expect(violations.map((v) => v.code)).toContain('unbridged_transferable_claim');
    });

    it('bridged prose mention passes clean', () => {
        const r = base({ summary: 'Deep AWS CDK practice, transferable to Terraform workflows. Ships production AI systems.' });
        const { violations } = enforceProhibitedClaims(r);
        expect(violations).toEqual([]);
    });
});

describe('revalidateResumeContent', () => {
    beforeEach(() => { mockRun.mockReset(); });

    it('clean resume → returned unchanged, no repair call', async () => {
        const r = base();
        const { resume, violations } = await revalidateResumeContent(r, ctx);
        expect(resume).toStrictEqual(r);
        expect(violations).toEqual([]);
        expect(mockRun).not.toHaveBeenCalled();
    });

    it('reintroduced inventory triggers ONE bounded repair and re-asserts deterministics', async () => {
        const fixed = base();
        mockRun.mockResolvedValue({ data: fixed });
        const dirty = base({
            summary: 'Built 16-stack monorepo with 30 rules. Closing metric: 25 apps.',
            // Same title as the mocked repaired resume — the roster invariant
            // matches by title, so the repair's roster counts as intact.
            experience: [{ company: 'F', title: 'Technical Customer Service Associate', period: '2022 - Present', highlights: [
                'Engineered 16-CDK-stack monorepo.', 'Wrote 30 custom rules.', 'Manages 25 apps.',
            ] }],
        });
        const { resume, violations } = await revalidateResumeContent(dirty, ctx);
        expect(mockRun).toHaveBeenCalledTimes(1);
        expect(resume).toStrictEqual(fixed);
        expect(violations.map((v) => v.code)).toContain('summary_restates_bullets');
        expect(violations.map((v) => v.code)).not.toContain('content_revalidation_residual');
    });

    it('repair failure (fail-open) → residual reported, resume still deterministic-clean', async () => {
        mockRun.mockRejectedValue(new Error('down'));
        const dirty = base({
            summary: 'Built 16-stack monorepo with 30 rules. Ships systems.',
            experience: [{ company: 'F', title: 'E', period: 'p', highlights: ['16-CDK-stack build.', '30 rules written.'] }],
        });
        const { violations } = await revalidateResumeContent(dirty, ctx);
        expect(violations.map((v) => v.code)).toContain('content_revalidation_residual');
    });
});

describe('summary echo + problem bridge + cert years', () => {
    const dockProblem = 'build and maintain scalable, secure, reliable engineering infrastructure enabling cross-functional teams to ship production-ready solutions consistently — closing gaps in cloud infrastructure maturity, CI/CD reliability, and DevSecOps practices ensuring repeatability at scale';

    it('flags the run-237a9606 summary shape as an echo of the bullets', () => {
        const r = base({
            summary: 'Builds production DevOps platforms end to end: secure CI/CD pipelines, Kubernetes on EKS, multi-account IaC via AWS CDK, and three-pillar observability. AWS Certified DevOps Engineer.',
            experience: [{ company: 'F', title: 'Cloud & DevOps Engineer', period: '2022 - Present', highlights: [
                'Provisioned EKS platform across AWS accounts via AWS CDK with ArgoCD gitops and automated promotion.',
                'Designed CI/CD pipelines across GitHub Actions workflows with OIDC zero-credential federation.',
                'Deployed three-pillar observability stack with Prometheus, Loki, Tempo dashboards on Kubernetes.',
            ] }],
        });
        expect(summaryEchoSentences(r).length).toBeGreaterThan(0);
    });

    it('a positioning summary with a problem bridge does not echo', () => {
        const r = base({
            summary: 'Turns fragile release processes into repeatable, secure delivery foundations that whole teams can trust. That repeatability gap is the exact problem this role exists to close. AWS Certified DevOps Engineer.',
            experience: [{ company: 'F', title: 'E', period: 'p', highlights: [
                'Provisioned EKS platform across AWS accounts via CDK with ArgoCD gitops.',
            ] }],
        });
        expect(summaryEchoSentences(r)).toEqual([]);
    });

    it('flags a missing problem bridge; passes when bridged', () => {
        const noBridge: string[] = [];
        const r1 = base();
        const v1 = validateResume(r1, { ...ctx, companyProblem: dockProblem });
        noBridge.push(...v1.map((x) => x.code));
        expect(noBridge).toContain('summary_missing_problem_bridge');

        const r2 = base({ summary: 'Ships production AI and applies root-cause methodology to support escalations, bringing repeatability and reliability to cross-functional engineering delivery. 5 years across support and operations.' });
        const v2 = validateResume(r2, { ...ctx, companyProblem: dockProblem });
        expect(v2.map((x) => x.code)).not.toContain('summary_missing_problem_bridge');
    });

    it('corrects a wrong certification year in the array and the summary prose', () => {
        const r = base({
            summary: 'Ships production AI systems. AWS Certified DevOps Engineer – Professional (2024).',
            certifications: [{ name: 'AWS Certified DevOps Engineer – Professional', year: '2024', issuer: 'AWS' }],
        } as never);
        const { resume, violations } = enforceCertYears(r, [{ name: 'AWS Certified DevOps Engineer – Professional', date: '2025' }]);
        expect((resume.certifications[0] as { year: string }).year).toBe('2025');
        expect(resume.summary).toContain('(2025)');
        expect(violations.map((v) => v.code)).toEqual(['cert_year_corrected']);
    });

    it('matching year → untouched, no violation', () => {
        const r = base({ certifications: [{ name: 'AWS Certified DevOps Engineer – Professional', year: '2025', issuer: 'AWS' }] } as never);
        const { violations } = enforceCertYears(r, [{ name: 'AWS Certified DevOps Engineer – Professional', date: '2025' }]);
        expect(violations).toEqual([]);
    });
});

describe('compliance overclaim + metric-stuffed bullets', () => {
    it('flags the run-237a9606 compliance phrasing; passes rule-pack framing', () => {
        const bad = base({ experience: [{ company: 'F', title: 'Cloud & DevOps Engineer', period: '2022 - Present', highlights: [
            'Built severity-gated DevSecOps pipeline with CDK-Nag compliance (HIPAA, NIST 800-53, PCI DSS), blocking violations.',
            'Second grounded bullet keeps the role above the thin floor.',
        ] }] });
        expect(codes(bad)).toContain('compliance_overclaim');

        const good = base({ experience: [{ company: 'F', title: 'Cloud & DevOps Engineer', period: '2022 - Present', highlights: [
            'Built a policy-as-code gate (Checkov custom rules + CDK-Nag rule packs: HIPAA, NIST 800-53, PCI DSS) failing the pipeline on CRITICAL/HIGH misconfigurations.',
            'Second grounded bullet keeps the role above the thin floor.',
        ] }] });
        expect(codes(good)).not.toContain('compliance_overclaim');
    });

    it('flags a bullet stuffed with 3+ numbers; allows a before/after pair', () => {
        const stuffed = base({ experience: [{ company: 'F', title: 'Cloud & DevOps Engineer', period: '2022 - Present', highlights: [
            'Provisioned 16-stack platform across 4 accounts with 265+ assertions and 22 workflows.',
            'Second grounded bullet keeps the role above the thin floor.',
        ] }] });
        expect(codes(stuffed)).toContain('bullet_metric_stuffed');

        const pair = base({ experience: [{ company: 'F', title: 'Cloud & DevOps Engineer', period: '2022 - Present', highlights: [
            'Cut IAM deployment time from 8 minutes of manual work to 30 seconds by codifying the platform in CDK.',
            'Second grounded bullet keeps the role above the thin floor.',
        ] }] });
        expect(codes(pair)).not.toContain('bullet_metric_stuffed');
    });
});

describe('checkExperienceFidelity — bullets must restate the ingested facts', () => {
	const METAFACTS =
		"Configured and troubleshot enterprise platform deployments on Meta's ad infrastructure. Worked on campaign delivery reliability and tracked performance metrics across distributed systems. " +
		'Wrote standardised operational procedures and reusable configuration templates. These cut resolution times for recurring platform issues. ' +
		'Built SQL-based monitoring dashboards and correlation queries for platform health. ' +
		'Worked across engineering and operations teams to find process bottlenecks, reduce escalation turnaround, and simplify operational workflows';
	const employers = [{ name: 'Meta via Accenture', facts: METAFACTS }];

	const entry = (highlights: string[]) => ({
		experience: [{ company: 'Meta via Accenture', title: 'Quality Assurance Analyst', period: '2021 - 2022', highlights }],
	}) as never;

	it('flags the content-moderation fabrication (observed live — zero grounding in the ingested facts)', async () => {
		const { checkExperienceFidelity } = await import('./resume-guard.js');
		const violations = checkExperienceFidelity(entry([
			'Performed structured quality assurance on content moderation workflows, applying systematic test strategies.',
			'Collaborated with engineering and operations teams to standardise testing procedures across moderation pipelines.',
		]), employers);
		expect(violations.some((v) => v.code === 'experience_ungrounded')).toBe(true);
	});

	it('flags the test-strategy/quality-gate fabrication (observed live)', async () => {
		const { checkExperienceFidelity } = await import('./resume-guard.js');
		const violations = checkExperienceFidelity(entry([
			'Designed test strategies, quality gate processes, and cross-functional workflow documentation for digital pipelines.',
			'Translating quality requirements into actionable specifications adopted across adjacent teams.',
		]), employers);
		expect(violations.some((v) => v.code === 'experience_ungrounded')).toBe(true);
	});

	it('passes a faithful JD-tailored rephrase of the ingested facts', async () => {
		const { checkExperienceFidelity } = await import('./resume-guard.js');
		const violations = checkExperienceFidelity(entry([
			"Troubleshot enterprise deployments on Meta's ad infrastructure, tracking campaign delivery reliability metrics across distributed systems.",
			'Built SQL-based monitoring dashboards and correlation queries, spotting anomalies before they became incidents.',
		]), employers);
		expect(violations).toEqual([]);
	});

	it('ignores entries with no matching verified employer (projects, solo work)', async () => {
		const { checkExperienceFidelity } = await import('./resume-guard.js');
		const violations = checkExperienceFidelity(entry(['Anything at all here.']), [{ name: 'SomeOther Corp', facts: 'irrelevant facts' }]);
		expect(violations).toEqual([]);
	});
});

describe('checkProjectPitchAlignment — run 048379a3 shipped telegraphic projects ignoring the documented pitch', () => {
    const PITCHES = [
        { name: 'AI Applications Platform with Infrastructure-as-Code', pitch: 'Tucaken is a SaaS for software engineers who want a resume that is honest and tailored per job posting - grounded in what their actual code shows, not keyword stuffing. A job-seeker connects their GitHub account.' },
        { name: 'frontend-portfolio', pitch: 'Most personal portfolios are static pages you scroll. This one you can interrogate. Recruiters and engineers visit nelsonlamounier.com to read technical articles on DevOps and cloud architecture.' },
    ];

    const project = (name: string, description: string) => base({
        projects: [{ name, github: 'github.com/x/y', description }],
    });

    it('passes a description that opens on the documented pitch (the run-30fe4f66 shape)', () => {
        const r = project(
            'AI Applications Platform with Infrastructure-as-Code (Tucaken)',
            'Tucaken is a SaaS for software engineers who ground resumes in verified code evidence, job-seeker connects their Git repository, Bedrock evidence-matching agent assesses code against requirements.',
        );
        expect(checkProjectPitchAlignment(r, PITCHES)).toEqual([]);
    });

    it('flags a telegraphic description that abandons the pitch (the run-048379a3 shape)', () => {
        const r = project(
            'AI Applications Platform with Infrastructure-as-Code (Tucaken)',
            'SaaS integrating Git repository analysis with AWS CDK, GitHub Actions, and policy-as-code scanning to surface real infrastructure decisions. Migrated cluster edge from Traefik NLB to WAFv2 ALB.',
        );
        const v = checkProjectPitchAlignment(r, PITCHES);
        expect(v).toHaveLength(1);
        expect(v[0]!.code).toBe('project_pitch_missing');
    });

    it('flags a pipeline-only portfolio description', () => {
        const r = project(
            'Frontend Portfolio',
            'Production Next.js portfolio deployed via automated GitOps blue-green rollouts. Quality gates: 307-test suite and SonarCloud scanning on every merge.',
        );
        expect(checkProjectPitchAlignment(r, PITCHES).map((x) => x.code)).toEqual(['project_pitch_missing']);
    });

    it('ignores projects with no documented pitch and empty pitch lists', () => {
        const r = project('Unknown Side Project', 'Anything at all.');
        expect(checkProjectPitchAlignment(r, PITCHES)).toEqual([]);
        expect(checkProjectPitchAlignment(r, [])).toEqual([]);
    });
});

describe('checkBulletJdEcho — run 048379a3 fabricated "Configured enterprise platform deployments" on the Meta QA role', () => {
    const EMPLOYERS = [{
        name: 'Meta via Accenture',
        facts: 'Designed and documented cross-functional QA processes adopted across multiple operational teams, reducing escalation turnaround by implementing root-cause analysis workflows. Built HTML/CSS/JavaScript internal knowledge-base tooling covering QA processes and cross-team escalation paths, standardizing operational runbooks and enabling faster resolution through comprehensive documentation.',
    }];
    const JD_TOKENS = 'Deployment Engineer: Python, JavaScript, cloud platforms (AWS/GCP/Azure), system integration, APIs, networking, enterprise deployments';

    it('flags a career bullet built from JD vocabulary absent from the employer facts', () => {
        const r = base({
            experience: [{
                company: 'Meta via Accenture', title: 'Quality Assurance Analyst', period: '2021 - 2022',
                highlights: ['Configured enterprise platform deployments and produced standardized operational procedures adopted across teams, reducing resolution times.'],
            }],
        });
        const v = checkBulletJdEcho(r, EMPLOYERS, JD_TOKENS);
        expect(v).toHaveLength(1);
        expect(v[0]!.code).toBe('experience_bullet_jd_echo');
    });

    it('passes an honest paraphrase grounded in the employer facts (the run-30fe4f66 shape)', () => {
        const r = base({
            experience: [{
                company: 'Meta via Accenture', title: 'Quality Assurance Analyst', period: '2021 - 2022',
                highlights: [
                    'Designed operational procedures for Meta content operations, reducing case resolution times and accelerating team onboarding.',
                    'Collaborated with engineering teams to scope quality gates and document workflow improvements.',
                ],
            }],
        });
        expect(checkBulletJdEcho(r, EMPLOYERS, JD_TOKENS)).toEqual([]);
    });

    it('never flags entries with no matching employer, and tolerates empty inputs', () => {
        const r = base({
            experience: [{ company: 'Unknown Corp', title: 'X', period: 'p', highlights: ['Enterprise platform deployments everywhere.'] }],
        });
        expect(checkBulletJdEcho(r, EMPLOYERS, JD_TOKENS)).toEqual([]);
        expect(checkBulletJdEcho(r, [], JD_TOKENS)).toEqual([]);
        expect(checkBulletJdEcho(r, EMPLOYERS, '')).toEqual([]);
    });
});
