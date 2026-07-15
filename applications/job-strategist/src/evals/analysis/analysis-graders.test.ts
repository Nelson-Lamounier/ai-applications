/** @format */
import { describe, it, expect } from '@jest/globals';
import {
    runAnalysisGraders,
    archetypeValidGrader,
    noGapFabricationGrader,
    fitRatingGrader,
} from './analysis-graders.js';
import {
    GOLDEN_ANALYSIS,
    ADVERSARIAL_ARCHETYPE_INVALID,
    ADVERSARIAL_GAP_FABRICATION,
    ADVERSARIAL_BOGUS_RATING,
} from './fixtures.js';

describe('analysis graders', () => {
    it('the golden analysis passes every grader', () => {
        const r = runAnalysisGraders(GOLDEN_ANALYSIS);
        expect(r.results.filter((x) => !x.pass)).toEqual([]);
        expect(r.pass).toBe(true);
    });

    it('an out-of-range archetypeId fails ONLY archetypeValidGrader', () => {
        const r = runAnalysisGraders(ADVERSARIAL_ARCHETYPE_INVALID);
        expect(archetypeValidGrader(ADVERSARIAL_ARCHETYPE_INVALID).pass).toBe(false);
        expect(noGapFabricationGrader(ADVERSARIAL_ARCHETYPE_INVALID).pass).toBe(true);
        expect(fitRatingGrader(ADVERSARIAL_ARCHETYPE_INVALID).pass).toBe(true);
        expect(r.results.filter((x) => !x.pass).map((x) => x.grader)).toEqual(['archetypeValid']);
        expect(r.pass).toBe(false);
    });

    it('a fabricated gap mitigation fails ONLY noGapFabricationGrader', () => {
        const r = runAnalysisGraders(ADVERSARIAL_GAP_FABRICATION);
        expect(archetypeValidGrader(ADVERSARIAL_GAP_FABRICATION).pass).toBe(true);
        expect(noGapFabricationGrader(ADVERSARIAL_GAP_FABRICATION).pass).toBe(false);
        expect(fitRatingGrader(ADVERSARIAL_GAP_FABRICATION).pass).toBe(true);
        expect(r.results.filter((x) => !x.pass).map((x) => x.grader)).toEqual(['noGapFabrication']);
        expect(r.pass).toBe(false);
    });

    it('a bogus fit rating fails ONLY fitRatingGrader', () => {
        const r = runAnalysisGraders(ADVERSARIAL_BOGUS_RATING);
        expect(archetypeValidGrader(ADVERSARIAL_BOGUS_RATING).pass).toBe(true);
        expect(noGapFabricationGrader(ADVERSARIAL_BOGUS_RATING).pass).toBe(true);
        expect(fitRatingGrader(ADVERSARIAL_BOGUS_RATING).pass).toBe(false);
        expect(r.results.filter((x) => !x.pass).map((x) => x.grader)).toEqual(['fitRating']);
        expect(r.pass).toBe(false);
    });

    it('noGapFabrication passes vacuously when there are no gap mitigations', () => {
        const r = noGapFabricationGrader({ ...GOLDEN_ANALYSIS, result: { ...GOLDEN_ANALYSIS.result, gapMitigations: [] } });
        expect(r.pass).toBe(true);
    });
});
