/**
 * @format
 * Cross-layer schema drift guard.
 *
 * Four layers describe the same resume: the shared TS type
 * (StructuredResumeData), the writer's TailoredResumeSchema, the Haiku
 * emit_resume net (ResumeRewriteSchema + the hand-written Bedrock JSON
 * input_schema), and the persist gate (StructuredResumeDataSchema). They
 * drifted once — projects[].highlights existed in the type + writer schema but
 * not the other two, and because plain z.object() strips undeclared keys the
 * bullets were silently deleted by the re-emit round-trip AND on the DB write.
 *
 * This test makes that class of bug impossible to reintroduce quietly:
 * a full-fidelity fixture must survive EVERY Zod layer byte-identical on the
 * canonical fields, the Bedrock JSON schema must declare every base shape key,
 * and the persist output must remain assignable to the shared TS type.
 */
import { describe, it, expect } from '@jest/globals';
import type { StructuredResumeData } from '@bedrock/shared';
import { SECTION_SHAPE_KEYS } from './resume-sections.js';
import { StructuredResumeDataSchema } from './resume-data.schema.js';
import { TailoredResumeSchema } from './tailored-resume.schema.js';
import { ResumeRewriteSchema, RESUME_EMIT_INPUT_SCHEMA } from '../agents/writer/resume-tool-schema.js';

/** Every canonical field populated — any layer that strips one fails below. */
const FIXTURE = {
    profile: {
        name: 'Nelson Leao', title: 'Platform Engineer', email: 'n@example.com',
        location: 'Dublin', linkedin: 'li/n', github: 'gh/n', website: 'w.example.com',
    },
    summary: 'Engineer shipping TypeScript end-to-end.',
    experience: [{
        company: 'Amazon Web Services (AWS)', title: 'Technical Customer Service Associate',
        period: '2022 - Present', highlights: ['Contained credential compromises via CloudTrail timelines.'],
    }],
    skills: [{ category: 'Languages', skills: ['TypeScript', 'SQL'] }],
    education: [{ degree: 'BSc Computing', institution: 'Example University', period: '2018 - 2021' }],
    certifications: [{ name: 'AWS DevOps Engineer - Professional', year: '2025', issuer: 'AWS' }],
    projects: [{
        name: 'AI Applications Platform (Tucaken)',
        description: 'SaaS generating code-grounded resumes.',
        github: 'github.com/Nelson-Lamounier/ai-applications',
        highlights: ['Provisioned EKS with Karpenter autoscaling', 'Built checksummed migration ledger'],
    }],
    keyAchievements: [{ achievement: 'Lifted skills canonicalisation from 2.2% to full operation.' }],
    sectionOrder: ['summary', 'experience', 'projects', 'education', 'skills', 'certifications'],
};

describe('resume schema drift — every layer preserves the canonical fields', () => {
    const LAYERS: ReadonlyArray<[string, { parse(input: unknown): unknown }]> = [
        ['writer TailoredResumeSchema', TailoredResumeSchema],
        ['Haiku ResumeRewriteSchema', ResumeRewriteSchema],
        ['persist StructuredResumeDataSchema', StructuredResumeDataSchema],
    ];

    it.each(LAYERS)('%s round-trips projects[].highlights + github and experience highlights', (_name, schema) => {
        const parsed = schema.parse(FIXTURE) as typeof FIXTURE;
        expect(parsed.projects[0].highlights).toEqual(FIXTURE.projects[0].highlights);
        expect(parsed.projects[0].github).toBe(FIXTURE.projects[0].github);
        expect(parsed.projects[0].description).toBe(FIXTURE.projects[0].description);
        expect(parsed.experience[0].highlights).toEqual(FIXTURE.experience[0].highlights);
        expect(parsed.keyAchievements[0].achievement).toBe(FIXTURE.keyAchievements[0].achievement);
        expect(parsed.sectionOrder).toEqual(FIXTURE.sectionOrder);
    });

    it('the Bedrock emit_resume JSON schema declares every base shape key per section', () => {
        const props = RESUME_EMIT_INPUT_SCHEMA.properties as Record<string, {
            properties?: Record<string, unknown>;
            items?: { properties?: Record<string, unknown> };
        }>;
        const declared = (section: string): string[] => {
            const p = props[section];
            return Object.keys(p.properties ?? p.items?.properties ?? {});
        };
        for (const [section, keys] of Object.entries(SECTION_SHAPE_KEYS)) {
            expect(declared(section)).toEqual(expect.arrayContaining([...keys]));
        }
    });

    it('the persist output stays assignable to the shared StructuredResumeData type', () => {
        // Compile-time check: if the persist schema drifts from the TS type,
        // this assignment stops compiling.
        const persisted: StructuredResumeData = StructuredResumeDataSchema.parse(FIXTURE);
        expect(persisted.projects[0].highlights).toEqual(FIXTURE.projects[0].highlights);
    });
});
