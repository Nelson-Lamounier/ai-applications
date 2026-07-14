/**
 * @format
 * Pure regression pinning restoreProjectHighlights semantics for its call
 * site in the run-pipeline ATS attainable-keyword loop: surfaceKeywords ->
 * applyLengthBudget -> stripUngroundedNumbers -> revalidateResumeContent ->
 * applyResumeIntegrity is a second Haiku emit_resume round-trip AFTER the
 * pre-loop guard chain already restored projects[].highlights once -- that
 * sequence can blank them again before the loop's re-persist. This pins the
 * REAL exported helper's before/after semantics so the run-pipeline call
 * (added immediately before the loop's re-persist) is protected by a test
 * that fails if the helper's restore-vs-preserve behaviour ever regresses.
 */
import { describe, it, expect } from '@jest/globals';
import type { StructuredResumeData } from '@bedrock/shared';
import { restoreProjectHighlights } from '../relocate-project-experience.js';

/** The pre-loop snapshot: projectHighlightsSnapshot, captured before the ATS attainable loop runs. */
const projectHighlightsSnapshot = {
    projects: [
        { name: 'AI Applications Platform (Tucaken)', github: 'gh/a', description: 'd', highlights: ['Deployed self-healing platform', 'Provisioned EKS cluster', 'Optimised chunk enrichment'] },
        { name: 'frontend-portfolio', github: 'gh/b', description: 'd', highlights: ['Automated blue-green deploys', 'Built 307-test Jest suite'] },
    ],
} as unknown as StructuredResumeData;

describe('restoreProjectHighlights -- ATS attainable-loop re-emit gap', () => {
    it('restores highlights the keyword-surfacing/length/revalidate/integrity sequence blanked', () => {
        // Simulate the loop's own applyResumeIntegrity output ("surfaced") having
        // dropped every project highlight on its emit_resume round-trip.
        const surfaced = {
            projects: projectHighlightsSnapshot.projects.map((p) => ({ ...p, highlights: [] })),
        } as unknown as StructuredResumeData;

        const restored = restoreProjectHighlights(projectHighlightsSnapshot, surfaced);

        expect(restored.projects[0].highlights).toEqual([
            'Deployed self-healing platform', 'Provisioned EKS cluster', 'Optimised chunk enrichment',
        ]);
        expect(restored.projects[1].highlights).toEqual([
            'Automated blue-green deploys', 'Built 307-test Jest suite',
        ]);
    });

    it('restores a partial drop (fewer highlights survive the round-trip than went in)', () => {
        const surfaced = {
            projects: [
                { ...projectHighlightsSnapshot.projects[0], highlights: ['Provisioned EKS cluster'] }, // 1 of 3 survived
                { ...projectHighlightsSnapshot.projects[1] },
            ],
        } as unknown as StructuredResumeData;

        const restored = restoreProjectHighlights(projectHighlightsSnapshot, surfaced);

        expect(restored.projects[0].highlights).toEqual([
            'Deployed self-healing platform', 'Provisioned EKS cluster', 'Optimised chunk enrichment',
        ]);
    });

    it('does NOT clobber a project the loop legitimately grew (more highlights after than before)', () => {
        const surfaced = {
            projects: [
                { ...projectHighlightsSnapshot.projects[0] },
                {
                    ...projectHighlightsSnapshot.projects[1],
                    highlights: ['Automated blue-green deploys', 'Built 307-test Jest suite', 'Surfaced Terraform keyword from evidence'],
                },
            ],
        } as unknown as StructuredResumeData;

        const restored = restoreProjectHighlights(projectHighlightsSnapshot, surfaced);

        expect(restored.projects[1].highlights).toEqual([
            'Automated blue-green deploys', 'Built 307-test Jest suite', 'Surfaced Terraform keyword from evidence',
        ]);
    });
});
