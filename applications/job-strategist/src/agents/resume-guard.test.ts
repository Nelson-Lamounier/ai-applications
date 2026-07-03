/** @format */
jest.mock('@bedrock/shared', () => ({
    ...jest.requireActual('@bedrock/shared'),
    runAgent: jest.fn(),
    log: () => undefined,
}));
import { runAgent } from '@bedrock/shared';
import { guardResume, validateResume, enforceScopedClaims, dropKeyAchievementsSection, summarySharedNumbers, enforceProhibitedClaims, revalidateResumeContent, summaryEchoSentences, enforceCertYears } from './resume-guard.js';
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

    it('allows exactly one shared number (the closing metric)', () => {
        const r = base({
            summary: 'Ships production AI and applies root-cause methodology to support escalations. Positioning prose without bullet facts. Closing metric: 25 ArgoCD apps.',
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
            experience: [{ company: 'F', title: 'Cloud & DevOps Engineer', period: '2022 - Present', highlights: [
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
