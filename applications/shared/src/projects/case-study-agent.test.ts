/** @format */
import { describe, it, expect } from '@jest/globals';
import { buildSystemPrompt, buildUserMessage } from './case-study-agent.js';
import type { CaseStudyContext, PriorCaseStudy } from './case-study-types.js';

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

const prior: PriorCaseStudy = {
    tagline: 'old tagline', pitch: 'old pitch',
    decisions: [], highlights: [], challenges: [], stack: [],
};

describe('buildSystemPrompt — refine mode', () => {
    it('omits the REFINE block for a from-scratch run', () => {
        expect(buildSystemPrompt(baseCtx)).not.toMatch(/REFINE MODE/);
    });

    it('appends the REFINE block when a prior case study is present', () => {
        const out = buildSystemPrompt({ ...baseCtx, priorCaseStudy: prior });
        expect(out).toMatch(/REFINE MODE/);
        expect(out).toMatch(/PRESERVE prior/);
        expect(out).toMatch(/Reuse their `sourceSignals` verbatim/);
        // New-repo coverage guarantee.
        expect(out).toMatch(/COVERAGE/);
        expect(out).toMatch(/<newRepos>/);
        expect(out).toMatch(/at least one highlight AND one\s+challenge/);
    });

    it('composes refine with archetype calibration', () => {
        const out = buildSystemPrompt({
            ...baseCtx, priorCaseStudy: prior,
            archetype: { id: 'production_saas', name: 'Production SaaS' }, stage: 'senior',
        });
        expect(out).toMatch(/Project calibration/);
        expect(out).toMatch(/REFINE MODE/);
    });
});

describe('buildUserMessage — refine mode', () => {
    it('omits the priorCaseStudy block for a from-scratch run', () => {
        expect(buildUserMessage(baseCtx)).not.toMatch(/<priorCaseStudy>/);
    });

    it('includes the priorCaseStudy block when present', () => {
        const out = buildUserMessage({ ...baseCtx, priorCaseStudy: prior });
        expect(out).toMatch(/<priorCaseStudy>/);
        expect(out).toMatch(/old tagline/);
    });

    it('includes <newRepos> when under-represented repos are flagged', () => {
        const out = buildUserMessage({ ...baseCtx, priorCaseStudy: prior, refineNewRepos: ['acme/web'] });
        expect(out).toMatch(/<newRepos>/);
        expect(out).toMatch(/acme\/web/);
    });

    it('omits <newRepos> when the list is empty', () => {
        const out = buildUserMessage({ ...baseCtx, priorCaseStudy: prior, refineNewRepos: [] });
        expect(out).not.toMatch(/<newRepos>/);
    });
});

describe('emit_case_study tool schema — output trim', () => {
    it('does not ask the model for depthMarkers (deterministically derived, then overridden)', async () => {
        const { CASE_STUDY_TOOL } = await import('./case-study-agent.js');
        expect(CASE_STUDY_TOOL.inputSchema.properties).not.toHaveProperty('depthMarkers');
        expect(CASE_STUDY_TOOL.inputSchema.required).not.toContain('depthMarkers');
        // The prompt rule describing depthMarkers must be gone too.
        expect(buildSystemPrompt(baseCtx)).not.toMatch(/depthMarkers/);
    });

    it('caps resumeBullets at 3 angle sets of ≤250-char bullets (matches prompt rule 7)', async () => {
        const { CASE_STUDY_TOOL } = await import('./case-study-agent.js');
        const rb = CASE_STUDY_TOOL.inputSchema.properties.resumeBullets as {
            maxItems: number;
            items: { properties: { bullets: { items: { maxLength: number } } } };
        };
        expect(rb.maxItems).toBe(3);
        expect(rb.items.properties.bullets.items.maxLength).toBe(250);
    });
});
