/** @format */
import { assembleProseLinterSystemPrompt } from './system-prompt.js';
import { PROSE_QUALITY_TOOL } from './tool-schema.js';

describe('assembleProseLinterSystemPrompt', () => {
    it('returns a cached block then the rules text', () => {
        const blocks = assembleProseLinterSystemPrompt();
        // shape: [{ text }, { cachePoint }] — rules are static, so cache after them.
        const text = blocks.map(b => (b as { text?: string }).text ?? '').join('\n');
        expect(text).toContain('Throat-Clearing Openers');
        expect(text).toContain('Binary Contrasts');
        expect(text).toContain('Directness');
        expect(blocks.some(b => 'cachePoint' in (b as object))).toBe(true);
    });
});

describe('PROSE_QUALITY_TOOL', () => {
    it('requires status, score, belowThreshold, issues', () => {
        const props = PROSE_QUALITY_TOOL.inputSchema.properties;
        expect(Object.keys(props)).toEqual(
            expect.arrayContaining(['status', 'score', 'belowThreshold', 'issues']),
        );
        expect(PROSE_QUALITY_TOOL.inputSchema.required).toEqual(
            expect.arrayContaining(['status', 'score', 'belowThreshold', 'issues']),
        );
    });
});
