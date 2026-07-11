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
import { relocateProjectExperience, restoreProjectHighlights } from '../relocate-project-experience.js';
import type { ProjectResumeBulletSet } from '../../evidence/project-evidence-block.js';

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

    it('leaves experience untouched when there are no strays (all verified)', () => {
        const clean = { ...RESUME, experience: RESUME.experience.slice(0, 2) } as StructuredResumeData;
        const res = relocateProjectExperience(clean, VERIFIED, BULLETS);
        expect(res.experience).toHaveLength(2);
    });
});

describe('relocateProjectExperience — deterministic highlights fill', () => {
    // The writer emitted rich descriptions but ZERO bullets and NO fabricated
    // experience (live: National Facilities run 101cfa43). The project is also
    // RENAMED vs the DB bullet set, so the fill must match by token overlap.
    const RENAMED = {
        ...RESUME,
        experience: RESUME.experience.slice(0, 2),
        projects: [
            { name: 'Tucaken: AI Applications Platform', github: 'github.com/Nelson-Lamounier/ai-applications', description: 'SaaS grounding resumes in real GitHub code; EKS, Karpenter, CDK, Checkov policy gates, migration ledger.', highlights: [] },
            { name: 'Technical Portfolio with Bedrock RAG', github: 'github.com/Nelson-Lamounier/frontend-portfolio', description: 'Portfolio with a production RAG chatbot; blue-green deploys, 307-test Jest suite, SonarCloud gates.', highlights: [] },
        ],
    } as unknown as StructuredResumeData;

    const out = relocateProjectExperience(RENAMED, VERIFIED, BULLETS);

    it('fills each empty project from its best-overlap DB bullet set (rename-tolerant)', () => {
        const tuca = out.projects.find((p) => p.name === 'Tucaken: AI Applications Platform')!;
        const fe = out.projects.find((p) => p.name === 'Technical Portfolio with Bedrock RAG')!;
        expect((tuca.highlights ?? []).length).toBeGreaterThan(0);
        expect((fe.highlights ?? []).length).toBeGreaterThan(0);
        // Correct assignment despite the rename: Tucaken gets the platform bullets,
        // the portfolio gets the blue-green/Jest bullets.
        expect(tuca.highlights).toEqual(expect.arrayContaining([expect.stringContaining('Karpenter autoscaling')]));
        expect(fe.highlights).toEqual(expect.arrayContaining([expect.stringContaining('blue-green')]));
        expect((tuca.highlights ?? []).some((h) => /blue-green/.test(h))).toBe(false);
    });

    it('caps the fill and never overwrites a project the writer already populated', () => {
        const tuca = out.projects.find((p) => p.name === 'Tucaken: AI Applications Platform')!;
        expect((tuca.highlights ?? []).length).toBeLessThanOrEqual(6);
        // A project that already has highlights is left as-is.
        const prefilled = { ...RENAMED, projects: [{ ...(RENAMED.projects[0] as object), highlights: ['Hand-written bullet'] }] } as unknown as StructuredResumeData;
        const res = relocateProjectExperience(prefilled, VERIFIED, BULLETS);
        expect(res.projects[0].highlights).toEqual(['Hand-written bullet']);
    });
});

describe('restoreProjectHighlights — undo Haiku re-emit stripping', () => {
    const before = {
        projects: [
            { name: 'Tucaken: AI Applications Platform', github: 'gh/a', description: 'd', highlights: ['b1', 'b2', 'b3'] },
            { name: 'frontend-portfolio', github: 'gh/b', description: 'd', highlights: ['c1', 'c2'] },
        ],
    } as unknown as StructuredResumeData;

    it('restores highlights a downstream pass blanked (matched by name)', () => {
        // Simulate surface-metrics dropping projects[].highlights entirely.
        const after = { projects: before.projects.map((p) => ({ ...p, highlights: [] })) } as unknown as StructuredResumeData;
        const res = restoreProjectHighlights(before, after);
        expect(res.projects[0].highlights).toEqual(['b1', 'b2', 'b3']);
        expect(res.projects[1].highlights).toEqual(['c1', 'c2']);
    });

    it('is rename-tolerant and never removes bullets a pass legitimately kept', () => {
        const after = {
            projects: [
                { name: 'Tucaken Platform', github: 'gh/a', description: 'd', highlights: [] },           // renamed + stripped
                { name: 'frontend-portfolio', github: 'gh/b', description: 'd', highlights: ['c1', 'c2', 'c3-new'] }, // grew — keep
            ],
        } as unknown as StructuredResumeData;
        const res = restoreProjectHighlights(before, after);
        expect(res.projects[0].highlights).toEqual(['b1', 'b2', 'b3']); // restored despite rename
        expect(res.projects[1].highlights).toEqual(['c1', 'c2', 'c3-new']); // untouched (had >= before)
    });
});
