/** @format */
import { ResumeRewriteSchema, RESUME_EMIT_INPUT_SCHEMA } from './resume-tool-schema.js';

describe('emit_resume projects schema — preserves highlights', () => {
    it('declares projects[].highlights so re-emit passes do not strip the Projects bullets', () => {
        const projects = RESUME_EMIT_INPUT_SCHEMA.properties.projects as {
            items: { properties?: Record<string, unknown> };
        };
        expect(projects.items.properties).toBeDefined();
        expect(projects.items.properties).toHaveProperty('highlights');
        expect(projects.items.properties).toHaveProperty('name');
        expect(projects.items.properties).toHaveProperty('github');
    });

    it('keeps projects[].highlights through a zod round-trip (passthrough)', () => {
        const parsed = ResumeRewriteSchema.parse({
            profile: { name: 'n', title: 't', email: 'e', location: 'l' },
            summary: 's', experience: [], skills: [], education: [], certifications: [],
            projects: [{ name: 'P', description: 'd', github: 'g', highlights: ['b1', 'b2'] }],
            keyAchievements: [],
        });
        expect((parsed.projects[0] as { highlights?: string[] }).highlights).toEqual(['b1', 'b2']);
    });
});

describe('SkillCategorySchema string coercion', () => {
    it('coerces a comma-joined skills string into an array (the resume-expand fail-open cause)', () => {
        const parsed = ResumeRewriteSchema.safeParse({
            profile: { name: 'N', title: 'T', email: 'e', location: 'l' },
            summary: 's',
            experience: [], education: [], certifications: [], projects: [], keyAchievements: [],
            skills: [{ category: 'DevOps', skills: 'AWS CDK, Docker, Kubernetes' }],
        });
        expect(parsed.success).toBe(true);
        if (parsed.success) expect(parsed.data.skills[0].skills).toEqual(['AWS CDK', 'Docker', 'Kubernetes']);
    });

    it('array form passes through unchanged', () => {
        const parsed = ResumeRewriteSchema.safeParse({
            profile: { name: 'N', title: 'T', email: 'e', location: 'l' },
            summary: 's',
            experience: [], education: [], certifications: [], projects: [], keyAchievements: [],
            skills: [{ category: 'DevOps', skills: ['AWS CDK'] }],
        });
        expect(parsed.success).toBe(true);
        if (parsed.success) expect(parsed.data.skills[0].skills).toEqual(['AWS CDK']);
    });
});
