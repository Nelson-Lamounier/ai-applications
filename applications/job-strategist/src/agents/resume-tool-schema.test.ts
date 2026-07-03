/** @format */
import { ResumeRewriteSchema } from './resume-tool-schema.js';


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
