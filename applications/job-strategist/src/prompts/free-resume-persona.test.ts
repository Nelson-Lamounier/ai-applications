/**
 * @format
 * Free-resume persona pins — the content moved from a 231-line TS template
 * literal to content/free-resume-persona.md (the last pure-prose persona still
 * inlined in code). These pins hold the load-bearing rules through markdown
 * edits; byte-level integrity vs version bumps is enforced separately by
 * prompt-content-integrity.test.ts.
 */
import { describe, it, expect } from '@jest/globals';
import { FREE_RESUME_SYSTEM_PROMPT, FREE_RESUME_PERSONA_META } from './free-resume-persona.js';

describe('free-resume-persona meta', () => {
    it('loads from content/ with the ledger identity', () => {
        expect(FREE_RESUME_PERSONA_META.id).toBe('free-resume-persona');
        expect(Number(FREE_RESUME_PERSONA_META.version)).toBeGreaterThanOrEqual(1);
    });
});

describe('free-resume-persona load-bearing rules', () => {
    it('keeps the first-person candidate voice rule', () => {
        expect(FREE_RESUME_SYSTEM_PROMPT).toContain('"I built", "I led", "I reduced"');
    });

    it('keeps the anti-hallucination number rule (no evidence, no number)', () => {
        expect(FREE_RESUME_SYSTEM_PROMPT).toContain('No evidence → no number');
        expect(FREE_RESUME_SYSTEM_PROMPT).toContain('NEVER coin a numeric percentage');
    });

    it('keeps the exactly-3-paragraph cover-letter contract', () => {
        expect(FREE_RESUME_SYSTEM_PROMPT).toContain('exactly 3 paragraphs');
    });

    it('keeps the transferable-framing rule (never name a gap)', () => {
        expect(FREE_RESUME_SYSTEM_PROMPT).toContain('never name a gap');
    });

    it('keeps the emit_free_resume output contract', () => {
        expect(FREE_RESUME_SYSTEM_PROMPT).toContain('emit_free_resume');
        expect(FREE_RESUME_SYSTEM_PROMPT).toContain('Do NOT emit any prose outside the tool call.');
    });

    it('keeps employer/date fidelity anchored to careerFacts', () => {
        expect(FREE_RESUME_SYSTEM_PROMPT).toContain('Never invent an employer or extend a date');
    });
});
