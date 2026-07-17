/** @format */
import { describe, it, expect } from '@jest/globals';
import { buildSystemPrompt } from '../case-study-agent.js';
import type { CaseStudyContext } from '../case-study-types.js';

// Minimal context — only fields buildSystemPrompt reads (archetype/priorCaseStudy absent).
const baseContext = {} as unknown as CaseStudyContext;

describe('case-study system prompt — narrative directives', () => {
    const prompt = buildSystemPrompt(baseContext);

    it('D1: instructs one combined story, not per-repo fragments', () => {
        expect(prompt).toMatch(/ONE coherent project story/i);
        expect(prompt).toMatch(/do not narrate repo-by-repo/i);
    });

    it('D2: makes the work + collaboration the narrative spine', () => {
        expect(prompt).toMatch(/the work and the collaboration are the spine/i);
        expect(prompt).toMatch(/who built it/i);
    });

    it('D3: keeps the verifiedStack constraint but demotes tech to a grounding aid', () => {
        expect(prompt).toMatch(/MUST be drawn from/i);     // constraint preserved
        expect(prompt).toMatch(/grounding aid/i);           // demotion present
        expect(prompt).toMatch(/NOT the thing the narrative is organised around/i);
    });

    it('D4: asks for a confident, un-hedged voice', () => {
        expect(prompt).toMatch(/state it (directly|plainly)/i);
        expect(prompt).toMatch(/avoid hedged/i);
    });
});
