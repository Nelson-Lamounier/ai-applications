/** @format */
import { describe, it, expect } from '@jest/globals';
import { STRATEGIST_ANALYSIS_SYSTEM_PROMPT, STRATEGIST_ANALYSIS_META } from '../strategist-analysis.js';

const joined = STRATEGIST_ANALYSIS_SYSTEM_PROMPT.map((block) =>
    'text' in block ? block.text : ''
).join('\n');

describe('strategist-analysis-persona -- id/version + resume-authoring-stripped contract', () => {
    it('carries the strategist-analysis persona id', () => {
        expect(STRATEGIST_ANALYSIS_META.id).toBe('strategist-analysis');
    });

    it('explicitly instructs NOT to emit the tailored resume JSON -- dedicated passes own it', () => {
        expect(joined).toContain('Do NOT emit <tailored_resume_json>');
    });

    it('explicitly instructs NOT to emit the cover letter -- dedicated passes own it', () => {
        expect(joined).toContain('Do NOT emit <cover_letter>');
    });

    it('carries the archetype Phase-0 selection rules marker', () => {
        expect(joined).toContain('PHASE 0, ARCHETYPE SELECTION RULES');
        expect(joined).toContain('archetype_gap_detected = true');
    });

    it('carries the transferable-framing marker (never name a gap, never claim a missing skill)', () => {
        expect(joined).toContain('TRANSFERABLE FRAMING');
        expect(joined).toContain('do NOT name the gap');
    });

    it('preserves the phase_0/metadata/mitigation XML output contract', () => {
        expect(joined).toContain('<phase_0_archetype_selection>');
        expect(joined).toContain('<overall_fit_rating>');
        expect(joined).toContain('<mitigation>');
        expect(joined).toContain('<go_no_go>go|conditional|no_go</go_no_go>');
    });
});
