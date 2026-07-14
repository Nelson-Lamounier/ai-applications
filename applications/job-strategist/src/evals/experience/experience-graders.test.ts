/** @format */
import { describe, it, expect } from '@jest/globals';
import {
    runExperienceGraders,
    provenanceGrader,
    noFabricationGrader,
    atsCoverageGrader,
    voiceGrader,
    reorderGrader,
} from './experience-graders.js';
import { GOLDEN_NETWORKING, ADVERSARIAL_CROSS_ROLE, ADVERSARIAL_FABRICATION, ADVERSARIAL_REORDER } from './fixtures.js';

describe('experience graders', () => {
    it('the golden networking output passes every grader', () => {
        const r = runExperienceGraders(GOLDEN_NETWORKING);
        expect(r.results.filter((x) => !x.pass)).toEqual([]);
        expect(r.pass).toBe(true);
    });

    it('a cross-role citation fails ONLY provenanceGrader', () => {
        const r = runExperienceGraders(ADVERSARIAL_CROSS_ROLE);
        expect(provenanceGrader(ADVERSARIAL_CROSS_ROLE).pass).toBe(false);
        expect(noFabricationGrader(ADVERSARIAL_CROSS_ROLE).pass).toBe(true);
        expect(atsCoverageGrader(ADVERSARIAL_CROSS_ROLE).pass).toBe(true);
        expect(voiceGrader(ADVERSARIAL_CROSS_ROLE).pass).toBe(true);
        expect(reorderGrader(ADVERSARIAL_CROSS_ROLE).pass).toBe(true);
        expect(r.results.filter((x) => !x.pass).map((x) => x.grader)).toEqual(['provenance']);
        expect(r.pass).toBe(false);
    });

    it('an invented "47%" fails ONLY noFabricationGrader', () => {
        const r = runExperienceGraders(ADVERSARIAL_FABRICATION);
        expect(provenanceGrader(ADVERSARIAL_FABRICATION).pass).toBe(true);
        expect(noFabricationGrader(ADVERSARIAL_FABRICATION).pass).toBe(false);
        expect(atsCoverageGrader(ADVERSARIAL_FABRICATION).pass).toBe(true);
        expect(voiceGrader(ADVERSARIAL_FABRICATION).pass).toBe(true);
        expect(reorderGrader(ADVERSARIAL_FABRICATION).pass).toBe(true);
        expect(r.results.filter((x) => !x.pass).map((x) => x.grader)).toEqual(['noFabrication']);
        expect(r.pass).toBe(false);
    });

    it('reorderGrader fails when a non-covering bullet leads a covering role', () => {
        const r = runExperienceGraders(ADVERSARIAL_REORDER);
        expect(provenanceGrader(ADVERSARIAL_REORDER).pass).toBe(true);
        expect(noFabricationGrader(ADVERSARIAL_REORDER).pass).toBe(true);
        expect(atsCoverageGrader(ADVERSARIAL_REORDER).pass).toBe(true);
        expect(voiceGrader(ADVERSARIAL_REORDER).pass).toBe(true);
        expect(reorderGrader(ADVERSARIAL_REORDER).pass).toBe(false);
        expect(r.results.filter((x) => !x.pass).map((x) => x.grader)).toEqual(['reorder']);
        expect(r.pass).toBe(false);
    });

    it('atsCoverage passes vacuously when a fixture has no ATS targets', () => {
        const r = atsCoverageGrader({ ...GOLDEN_NETWORKING, atsTargets: [] });
        expect(r.pass).toBe(true);
    });

    it('atsCoverage fails when the output misses too many targets', () => {
        const r = atsCoverageGrader({
            ...GOLDEN_NETWORKING,
            output: {
                ...GOLDEN_NETWORKING.output,
                roles: [
                    { ...GOLDEN_NETWORKING.output.roles[0], highlights: [] },
                    GOLDEN_NETWORKING.output.roles[1],
                ],
            },
        });
        expect(r.pass).toBe(false);
    });

    it('reorderGrader passes vacuously when no bullet covers any target', () => {
        const r = reorderGrader({ ...GOLDEN_NETWORKING, atsTargets: [] });
        expect(r.pass).toBe(true);
    });
});
