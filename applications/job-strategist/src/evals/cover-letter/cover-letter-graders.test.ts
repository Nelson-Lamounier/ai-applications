/** @format */
import { describe, it, expect } from '@jest/globals';
import {
    runCoverLetterGraders,
    paragraphCountGrader,
    signoffCompleteGrader,
    noEmDashGrader,
    tenureConditionalGrader,
    thirdPersonGrader,
} from './cover-letter-graders.js';
import {
    GOLDEN_LETTER_INPUT,
    ADVERSARIAL_PARAGRAPH_COUNT,
    ADVERSARIAL_SIGNOFF,
    ADVERSARIAL_EM_DASH,
    ADVERSARIAL_TENURE,
    ADVERSARIAL_THIRD_PERSON,
} from './fixtures.js';

describe('cover-letter graders', () => {
    it('the golden letter passes every grader', () => {
        const r = runCoverLetterGraders(GOLDEN_LETTER_INPUT);
        expect(r.results.filter((x) => !x.pass)).toEqual([]);
        expect(r.pass).toBe(true);
    });

    it('a 2-paragraph letter fails ONLY paragraphCountGrader', () => {
        const r = runCoverLetterGraders(ADVERSARIAL_PARAGRAPH_COUNT);
        expect(paragraphCountGrader(ADVERSARIAL_PARAGRAPH_COUNT).pass).toBe(false);
        expect(signoffCompleteGrader(ADVERSARIAL_PARAGRAPH_COUNT).pass).toBe(true);
        expect(noEmDashGrader(ADVERSARIAL_PARAGRAPH_COUNT).pass).toBe(true);
        expect(tenureConditionalGrader(ADVERSARIAL_PARAGRAPH_COUNT).pass).toBe(true);
        expect(thirdPersonGrader(ADVERSARIAL_PARAGRAPH_COUNT).pass).toBe(true);
        expect(r.results.filter((x) => !x.pass).map((x) => x.grader)).toEqual(['paragraphCount']);
        expect(r.pass).toBe(false);
    });

    it('a blank signoff email fails ONLY signoffCompleteGrader', () => {
        const r = runCoverLetterGraders(ADVERSARIAL_SIGNOFF);
        expect(paragraphCountGrader(ADVERSARIAL_SIGNOFF).pass).toBe(true);
        expect(signoffCompleteGrader(ADVERSARIAL_SIGNOFF).pass).toBe(false);
        expect(noEmDashGrader(ADVERSARIAL_SIGNOFF).pass).toBe(true);
        expect(tenureConditionalGrader(ADVERSARIAL_SIGNOFF).pass).toBe(true);
        expect(thirdPersonGrader(ADVERSARIAL_SIGNOFF).pass).toBe(true);
        expect(r.results.filter((x) => !x.pass).map((x) => x.grader)).toEqual(['signoffComplete']);
        expect(r.pass).toBe(false);
    });

    it('an em-dash in the body fails ONLY noEmDashGrader', () => {
        const r = runCoverLetterGraders(ADVERSARIAL_EM_DASH);
        expect(paragraphCountGrader(ADVERSARIAL_EM_DASH).pass).toBe(true);
        expect(signoffCompleteGrader(ADVERSARIAL_EM_DASH).pass).toBe(true);
        expect(noEmDashGrader(ADVERSARIAL_EM_DASH).pass).toBe(false);
        expect(tenureConditionalGrader(ADVERSARIAL_EM_DASH).pass).toBe(true);
        expect(thirdPersonGrader(ADVERSARIAL_EM_DASH).pass).toBe(true);
        expect(r.results.filter((x) => !x.pass).map((x) => x.grader)).toEqual(['noEmDash']);
        expect(r.pass).toBe(false);
    });

    it('a tenure mention with no years bar fails ONLY tenureConditionalGrader', () => {
        const r = runCoverLetterGraders(ADVERSARIAL_TENURE);
        expect(paragraphCountGrader(ADVERSARIAL_TENURE).pass).toBe(true);
        expect(signoffCompleteGrader(ADVERSARIAL_TENURE).pass).toBe(true);
        expect(noEmDashGrader(ADVERSARIAL_TENURE).pass).toBe(true);
        expect(tenureConditionalGrader(ADVERSARIAL_TENURE).pass).toBe(false);
        expect(thirdPersonGrader(ADVERSARIAL_TENURE).pass).toBe(true);
        expect(r.results.filter((x) => !x.pass).map((x) => x.grader)).toEqual(['tenureConditional']);
        expect(r.pass).toBe(false);
    });

    it('a third-person self-reference fails ONLY thirdPersonGrader', () => {
        const r = runCoverLetterGraders(ADVERSARIAL_THIRD_PERSON);
        expect(paragraphCountGrader(ADVERSARIAL_THIRD_PERSON).pass).toBe(true);
        expect(signoffCompleteGrader(ADVERSARIAL_THIRD_PERSON).pass).toBe(true);
        expect(noEmDashGrader(ADVERSARIAL_THIRD_PERSON).pass).toBe(true);
        expect(tenureConditionalGrader(ADVERSARIAL_THIRD_PERSON).pass).toBe(true);
        expect(thirdPersonGrader(ADVERSARIAL_THIRD_PERSON).pass).toBe(false);
        expect(r.results.filter((x) => !x.pass).map((x) => x.grader)).toEqual(['thirdPerson']);
        expect(r.pass).toBe(false);
    });

    it('tenureConditional passes vacuously when hasYearsBar is true', () => {
        const r = tenureConditionalGrader({ ...GOLDEN_LETTER_INPUT, hasYearsBar: true });
        expect(r.pass).toBe(true);
    });
});
