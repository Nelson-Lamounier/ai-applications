/** @format */
import { describe, it, expect } from '@jest/globals';
import { mapTechCategoryToSkillCategory, SKILL_CATEGORIES } from './skill-patterns.js';

describe('mapTechCategoryToSkillCategory', () => {
    it('maps representative tech categories to sensible skill categories', () => {
        expect(mapTechCategoryToSkillCategory('framework_web')).toBe('frontend');
        expect(mapTechCategoryToSkillCategory('ci_cd')).toBe('devops');
        expect(mapTechCategoryToSkillCategory('database_relational')).toBe('database');
        expect(mapTechCategoryToSkillCategory('database_vector')).toBe('data');
        expect(mapTechCategoryToSkillCategory('cloud_compute')).toBe('cloud');
        expect(mapTechCategoryToSkillCategory('auth')).toBe('security');
        expect(mapTechCategoryToSkillCategory('ai_platform')).toBe('ml');
    });

    it('falls back to other for unknown categories', () => {
        expect(mapTechCategoryToSkillCategory('something_new')).toBe('other');
        expect(mapTechCategoryToSkillCategory('')).toBe('other');
    });

    it('every mapping target is a valid skill_ontology category', () => {
        const targets = ['cloud_compute', 'language', 'developer_tool', 'database_vector', 'message_broker', 'iac', 'payment', 'unknown']
            .map(mapTechCategoryToSkillCategory);
        for (const t of targets) expect(SKILL_CATEGORIES).toContain(t);
    });
});
