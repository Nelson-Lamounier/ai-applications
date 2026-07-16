/** @format */
import { describe, it, expect } from '@jest/globals';
import {
    runProjectsGraders,
    provenanceGrader,
    quoteFidelityGrader,
    compositionGrader,
    atsCoverageGrader,
    descriptionGrader,
} from './projects-graders.js';
import { GOLDEN_TWO_LANE, ADVERSARIAL_CROSS_PROJECT, ADVERSARIAL_RETYPED_QUOTE, ADVERSARIAL_OVER_CAP_COMPOSED } from './fixtures.js';

describe('projects graders', () => {
    it('the golden two-lane (staleness) output passes every grader', () => {
        const r = runProjectsGraders(GOLDEN_TWO_LANE);
        expect(r.results.filter((x) => !x.pass)).toEqual([]);
        expect(r.pass).toBe(true);
    });

    it('a cross-project curated citation fails ONLY provenanceGrader', () => {
        const r = runProjectsGraders(ADVERSARIAL_CROSS_PROJECT);
        expect(provenanceGrader(ADVERSARIAL_CROSS_PROJECT).pass).toBe(false);
        expect(quoteFidelityGrader(ADVERSARIAL_CROSS_PROJECT).pass).toBe(true);
        expect(compositionGrader(ADVERSARIAL_CROSS_PROJECT).pass).toBe(true);
        expect(atsCoverageGrader(ADVERSARIAL_CROSS_PROJECT).pass).toBe(true);
        expect(descriptionGrader(ADVERSARIAL_CROSS_PROJECT).pass).toBe(true);
        expect(r.results.filter((x) => !x.pass).map((x) => x.grader)).toEqual(['provenance']);
        expect(r.pass).toBe(false);
    });

    it('a retyped curated bullet in the rendered text fails ONLY quoteFidelityGrader', () => {
        const r = runProjectsGraders(ADVERSARIAL_RETYPED_QUOTE);
        expect(provenanceGrader(ADVERSARIAL_RETYPED_QUOTE).pass).toBe(true);
        expect(quoteFidelityGrader(ADVERSARIAL_RETYPED_QUOTE).pass).toBe(false);
        expect(compositionGrader(ADVERSARIAL_RETYPED_QUOTE).pass).toBe(true);
        expect(atsCoverageGrader(ADVERSARIAL_RETYPED_QUOTE).pass).toBe(true);
        expect(descriptionGrader(ADVERSARIAL_RETYPED_QUOTE).pass).toBe(true);
        expect(r.results.filter((x) => !x.pass).map((x) => x.grader)).toEqual(['quoteFidelity']);
        expect(r.pass).toBe(false);
    });

    it('seven composed bullets for one project (one over the Task 3 raised per-entry cap) fails '
        + 'provenanceGrader AND compositionGrader (shared cap invariant), nothing else', () => {
        const r = runProjectsGraders(ADVERSARIAL_OVER_CAP_COMPOSED);
        expect(provenanceGrader(ADVERSARIAL_OVER_CAP_COMPOSED).pass).toBe(false);
        expect(quoteFidelityGrader(ADVERSARIAL_OVER_CAP_COMPOSED).pass).toBe(true);
        expect(compositionGrader(ADVERSARIAL_OVER_CAP_COMPOSED).pass).toBe(false);
        expect(atsCoverageGrader(ADVERSARIAL_OVER_CAP_COMPOSED).pass).toBe(true);
        expect(descriptionGrader(ADVERSARIAL_OVER_CAP_COMPOSED).pass).toBe(true);
        expect(r.results.filter((x) => !x.pass).map((x) => x.grader).sort()).toEqual(['composition', 'provenance']);
        expect(r.pass).toBe(false);
    });

    it('atsCoverage passes vacuously when a fixture has no ATS targets', () => {
        const r = atsCoverageGrader({ ...GOLDEN_TWO_LANE, atsTargets: [] });
        expect(r.pass).toBe(true);
    });

    it('atsCoverage fails when the rendered text misses too many targets', () => {
        const r = atsCoverageGrader({
            ...GOLDEN_TWO_LANE,
            assembled: [{ name: 'Portfolio', description: 'unrelated filler text', github: 'github.com/o/portfolio', highlights: [] }],
        });
        expect(r.pass).toBe(false);
    });
});
