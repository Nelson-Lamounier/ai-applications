/** @format */
import { describe, it, expect } from '@jest/globals';
import { buildSystemPrompt } from './case-study-agent.js';
import type { CaseStudyContext } from './case-study-types.js';

const baseCtx: CaseStudyContext = {
    projectId: 'p', projectName: 'P', tagline: null, pitch: null, userOverrides: {},
    components: [], repositories: [], commits: [], pulls: [], kbChunks: [],
};

describe('buildSystemPrompt', () => {
    it('returns the base prompt unchanged when no archetype', () => {
        const prompt = buildSystemPrompt(baseCtx);
        expect(prompt).not.toMatch(/Project calibration/);
    });

    it('appends a calibration block when an archetype is present', () => {
        const prompt = buildSystemPrompt({
            ...baseCtx,
            archetype: { id: 'production_saas', name: 'Production SaaS Application' },
            stage: 'senior',
            prioritySections: ['architecture', 'deployment'],
        });
        expect(prompt).toMatch(/Project calibration/);
        expect(prompt).toMatch(/senior-level Production SaaS Application/);
        expect(prompt).toMatch(/architecture, deployment/);
        expect(prompt).toMatch(/never truthfulness/);
    });

    it('includes a de-emphasis line when deemphasizedSections is set', () => {
        const prompt = buildSystemPrompt({
            ...baseCtx,
            archetype: { id: 'production_saas', name: 'Production SaaS Application' },
            stage: 'junior',
            prioritySections: ['hero'],
            deemphasizedSections: ['design_decisions'],
        });
        expect(prompt).toMatch(/De-emphasise: design_decisions\./);
    });

    it('handles archetype with null stage (uses "unspecified")', () => {
        const prompt = buildSystemPrompt({
            ...baseCtx,
            archetype: { id: 'cli_tool', name: 'Published CLI Tool' },
            stage: null,
            prioritySections: ['installation'],
        });
        expect(prompt).toMatch(/unspecified-level Published CLI Tool/);
    });
});
