/**
 * @format
 * Regression guard for relocateProjectExperience — reproduces the live
 * ServiceNow SRE run (234c1afe) where the writer spawned three
 * "Solo <role> — <Project>" experience entries (period "Project"), over-split
 * one project into two, and left projects[].highlights empty. Experience must
 * end up with ONLY the verified employers; every project bullet must land under
 * its project (the split-off "Infrastructure-as-Code Repos" merged back into
 * Tucaken by bullet overlap).
 */
import { describe, it, expect } from '@jest/globals';
import type { StructuredResumeData } from '@bedrock/shared';
import { relocateProjectExperience } from './relocate-project-experience.js';
import type { ProjectResumeBulletSet } from './project-evidence-block.js';

const VERIFIED = [{ name: 'Amazon Web Services (AWS)' }, { name: 'Meta via Accenture' }];

const BULLETS: ProjectResumeBulletSet[] = [
    {
        name: 'AI Applications Platform (Tucaken)',
        bullets: [
            'Deployed self-healing platform via Bedrock Claude agent diagnosing failures and triggering SSM remediation',
            'Provisioned EKS cluster with Pod Identity, Karpenter autoscaling, and WAFv2 ALB',
            'Authored Bash diagnostic CLI and TypeScript control-plane scripts following production Unix shell practices',
            'Replaced re-apply-every-boot migrations with checksummed ledger, eliminating silent idempotency bugs',
            'Optimised chunk enrichment via content-hash dedup and batch packing, reducing per-run cost from $3.65 to sub-$1',
        ],
    },
    {
        name: 'frontend-portfolio',
        bullets: [
            'Eliminated manual deploys via fully automated blue-green model: SSM to ArgoCD to Argo Rollouts',
            'Built 307-test Jest suite with coverage thresholds and SonarCloud quality gate, gating every merge',
        ],
    },
];

/** The writer's mis-structured output: 2 real jobs + 3 project-as-experience entries; projects have no highlights. */
const RESUME = {
    profile: { name: 'N', title: 'T', email: 'e', location: 'l' },
    summary: 's',
    experience: [
        { company: 'Amazon Web Services (AWS)', title: 'Technical Customer Service Associate', period: '2022 - Present', highlights: ['Contained credential compromises from CloudTrail'] },
        { company: 'Meta via Accenture', title: 'Quality Assurance Analyst', period: '2021 - 2022', highlights: ['Audited quality across a 50-person analyst team'] },
        { company: 'AI Applications Platform (Tucaken)', title: 'Solo Full-Stack SRE Engineer', period: 'Project', highlights: [
            'Deployed self-healing platform via Bedrock Claude agent diagnosing failures and triggering SSM remediation, eliminating manual incident response.',
            'Provisioned EKS cluster with Pod Identity, Karpenter autoscaling, and WAFv2 ALB, eliminating embedded credentials.',
        ] },
        { company: 'frontend-portfolio', title: 'Solo Full-Stack DevOps & Observability', period: 'Project', highlights: [
            'Eliminated manual deploys via fully automated blue-green model: SSM to ArgoCD to Argo Rollouts.',
            'Built 307-test Jest suite with coverage thresholds and SonarCloud quality gate, gating every merge.',
        ] },
        { company: 'Infrastructure-as-Code Repos', title: 'Solo Platform & Delivery Engineer', period: 'Project', highlights: [
            'Authored Bash diagnostic CLI and TypeScript control-plane scripts following production Unix shell practices.',
            'Replaced re-apply-every-boot migrations with checksummed ledger, eliminating silent idempotency bugs.',
        ] },
    ],
    skills: [],
    education: [],
    certifications: [],
    projects: [
        { name: 'AI Applications Platform (Tucaken)', github: 'github.com/Nelson-Lamounier/ai-applications', description: 'SaaS for code-grounded resumes.', highlights: [] },
        { name: 'frontend-portfolio', github: 'github.com/Nelson-Lamounier/frontend-portfolio', description: 'Portfolio you can interrogate.', highlights: [] },
    ],
    keyAchievements: [],
} as unknown as StructuredResumeData;

describe('relocateProjectExperience', () => {
    const out = relocateProjectExperience(RESUME, VERIFIED, BULLETS);

    it('leaves ONLY verified employers in experience', () => {
        expect(out.experience.map((e) => e.company)).toEqual([
            'Amazon Web Services (AWS)',
            'Meta via Accenture',
        ]);
        // No invented job titles / "Project" periods survive.
        expect(out.experience.some((e) => e.period === 'Project')).toBe(false);
        expect(out.experience.some((e) => /^Solo /.test(e.title))).toBe(false);
    });

    it('moves each stray project entry into its matching project by name', () => {
        const fe = out.projects.find((p) => p.name === 'frontend-portfolio')!;
        expect(fe.highlights).toEqual(expect.arrayContaining([
            expect.stringContaining('blue-green'),
            expect.stringContaining('307-test Jest'),
        ]));
    });

    it('merges the split-off "Infrastructure-as-Code Repos" back into Tucaken by bullet overlap', () => {
        const tuca = out.projects.find((p) => p.name === 'AI Applications Platform (Tucaken)')!;
        expect(tuca.highlights).toEqual(expect.arrayContaining([
            expect.stringContaining('self-healing platform'),
            expect.stringContaining('Karpenter autoscaling'),
            expect.stringContaining('Bash diagnostic CLI'),       // from the orphan IaC entry
            expect.stringContaining('checksummed ledger'),        // from the orphan IaC entry
        ]));
        // The orphan's bullets did NOT leak into the frontend project.
        const fe = out.projects.find((p) => p.name === 'frontend-portfolio')!;
        expect((fe.highlights ?? []).some((h) => /Bash diagnostic CLI/.test(h))).toBe(false);
    });

    it('preserves the project github links + descriptions', () => {
        const tuca = out.projects.find((p) => p.name === 'AI Applications Platform (Tucaken)')!;
        expect(tuca.github).toBe('github.com/Nelson-Lamounier/ai-applications');
        expect(tuca.description).toContain('code-grounded');
    });

    it('is a no-op when there are no strays (all experience is verified)', () => {
        const clean = { ...RESUME, experience: RESUME.experience.slice(0, 2) } as StructuredResumeData;
        const res = relocateProjectExperience(clean, VERIFIED, BULLETS);
        expect(res.experience).toHaveLength(2);
    });
});
