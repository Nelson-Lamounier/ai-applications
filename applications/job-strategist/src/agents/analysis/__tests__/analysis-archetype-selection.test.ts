/**
 * @format
 * Analysis Agent — Phase 0 archetype selection extraction.
 *
 * Relocated from `agents/writer/__tests__/strategist-archetype-selection.test.ts`
 * (Phase 5 PR-B Task 8 -- the writer's deletion): `extractArchetypeSelection`
 * moved to `analysis-extractors.ts` in Task 3, byte-identical. Covers the
 * clamp guard so that any newly-added archetype ID is not silently clamped to 1.
 */

import type { extractArchetypeSelection as ExtractArchetypeSelectionFn } from '../analysis-extractors.js';

let extractArchetypeSelection: typeof ExtractArchetypeSelectionFn;

beforeAll(async () => {
    ({ extractArchetypeSelection } = await import('../analysis-extractors.js'));
});

const wrap = (archetypeId: number, selectedArchetype: string) => `
<job_application_analysis>
  <phase_0_archetype_selection>
    <selected_archetype>${selectedArchetype}</selected_archetype>
    <archetype_id>${archetypeId}</archetype_id>
    <trigger_phrases_matched>
      <phrase>support</phrase>
    </trigger_phrases_matched>
    <excluded_content_categories>
      <category>none</category>
    </excluded_content_categories>
    <lead_identity><![CDATA[Support engineer who ships production systems.]]></lead_identity>
    <confidence_score>0.9</confidence_score>
    <archetype_gap_detected>false</archetype_gap_detected>
  </phase_0_archetype_selection>
</job_application_analysis>
`;

describe('extractArchetypeSelection', () => {
    it('returns null when the phase_0 section is absent', () => {
        expect(extractArchetypeSelection('<job_application_analysis></job_application_analysis>')).toBeNull();
    });

    it('parses archetype id 1 correctly', () => {
        const result = extractArchetypeSelection(wrap(1, 'Platform/Infra Engineer'));
        expect(result?.archetypeId).toBe(1);
        expect(result?.selectedArchetype).toBe('Platform/Infra Engineer');
    });

    it('parses archetype id 6 correctly', () => {
        const result = extractArchetypeSelection(wrap(6, 'Operations Engineering / Internal Tooling'));
        expect(result?.archetypeId).toBe(6);
    });

    it('parses archetype id 7 correctly — Technical Support / Customer Engineering', () => {
        const result = extractArchetypeSelection(
            wrap(7, 'Technical Support / Customer Engineering'),
        );
        expect(result?.archetypeId).toBe(7);
        expect(result?.selectedArchetype).toBe('Technical Support / Customer Engineering');
    });

    it('clamps an out-of-range archetype id to 1', () => {
        const result = extractArchetypeSelection(wrap(99, 'Unknown'));
        expect(result?.archetypeId).toBe(1);
    });

    it('parses confidence score and gap flag', () => {
        const result = extractArchetypeSelection(wrap(7, 'Technical Support / Customer Engineering'));
        expect(result?.confidenceScore).toBe(0.9);
        expect(result?.archetypeGapDetected).toBe(false);
    });
});
