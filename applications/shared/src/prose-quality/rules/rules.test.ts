/** @format */
import { PHRASE_RULES } from './phrases.js';
import { STRUCTURE_RULES } from './structures.js';
import { RUBRIC_RULES, PROSE_PASS_THRESHOLD } from './rubric.js';

describe('prose-quality rule modules', () => {
    it('phrase rules carry the known stop-slop anchors', () => {
        expect(PHRASE_RULES).toContain("It's worth noting");
        expect(PHRASE_RULES).toContain('Throat-Clearing Openers');
        expect(PHRASE_RULES.length).toBeGreaterThan(500);
    });
    it('structure rules carry the known stop-slop anchors', () => {
        expect(STRUCTURE_RULES).toContain('Binary Contrasts');
        expect(STRUCTURE_RULES).toContain('Passive Voice');
        expect(STRUCTURE_RULES.length).toBeGreaterThan(500);
    });
    it('rubric names the five dimensions and a 35 threshold', () => {
        for (const d of ['Directness', 'Rhythm', 'Trust', 'Authenticity', 'Density']) {
            expect(RUBRIC_RULES).toContain(d);
        }
        expect(PROSE_PASS_THRESHOLD).toBe(35);
    });
});
