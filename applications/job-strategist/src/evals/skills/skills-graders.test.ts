/** @format */
import { describe, it, expect } from '@jest/globals';
import {
    runSkillsGraders,
    membershipGrader,
    capsGrader,
    jdPriorityGrader,
} from './skills-graders.js';
import {
    GOLDEN_SKILLS,
    ADVERSARIAL_GAP_SKILL,
    ADVERSARIAL_SIX_CATEGORIES,
    ADVERSARIAL_REQUIRED_BURIED,
} from './fixtures.js';

describe('skills graders', () => {
    it('the golden skills output passes every grader', () => {
        const r = runSkillsGraders(GOLDEN_SKILLS);
        expect(r.results.filter((x) => !x.pass)).toEqual([]);
        expect(r.pass).toBe(true);
    });

    it('a gap-status skill fails ONLY membershipGrader', () => {
        const r = runSkillsGraders(ADVERSARIAL_GAP_SKILL);
        expect(membershipGrader(ADVERSARIAL_GAP_SKILL).pass).toBe(false);
        expect(capsGrader(ADVERSARIAL_GAP_SKILL).pass).toBe(true);
        expect(jdPriorityGrader(ADVERSARIAL_GAP_SKILL).pass).toBe(true);
        expect(r.results.filter((x) => !x.pass).map((x) => x.grader)).toEqual(['membership']);
        expect(r.pass).toBe(false);
    });

    it('6 categories fails ONLY capsGrader', () => {
        const r = runSkillsGraders(ADVERSARIAL_SIX_CATEGORIES);
        expect(membershipGrader(ADVERSARIAL_SIX_CATEGORIES).pass).toBe(true);
        expect(capsGrader(ADVERSARIAL_SIX_CATEGORIES).pass).toBe(false);
        expect(jdPriorityGrader(ADVERSARIAL_SIX_CATEGORIES).pass).toBe(true);
        expect(r.results.filter((x) => !x.pass).map((x) => x.grader)).toEqual(['caps']);
        expect(r.pass).toBe(false);
    });

    it('a buried required skill fails ONLY jdPriorityGrader', () => {
        const r = runSkillsGraders(ADVERSARIAL_REQUIRED_BURIED);
        expect(membershipGrader(ADVERSARIAL_REQUIRED_BURIED).pass).toBe(true);
        expect(capsGrader(ADVERSARIAL_REQUIRED_BURIED).pass).toBe(true);
        expect(jdPriorityGrader(ADVERSARIAL_REQUIRED_BURIED).pass).toBe(false);
        expect(r.results.filter((x) => !x.pass).map((x) => x.grader)).toEqual(['jdPriority']);
        expect(r.pass).toBe(false);
    });

    it('jdPriority passes vacuously when no JD-required skill is attainable', () => {
        const r = jdPriorityGrader({ ...GOLDEN_SKILLS, requiredSkills: ['Terraform'] });
        expect(r.pass).toBe(true);
    });
});
