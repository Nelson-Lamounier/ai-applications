/** @format */
import { stampProjectDescription } from '../projects-description.js';

describe('stampProjectDescription', () => {
    it('empty pitch -> empty string', () => {
        expect(stampProjectDescription('')).toBe('');
    });

    it('whitespace-only pitch -> empty string', () => {
        expect(stampProjectDescription('   \n\n   ')).toBe('');
    });

    it('single short paragraph -> returned verbatim (under the cap)', () => {
        const pitch = 'Tucaken is a career platform helping engineers land jobs faster with grounded evidence coaching.';
        expect(stampProjectDescription(pitch)).toBe(pitch);
    });

    it('multi-paragraph pitch -> first paragraph only', () => {
        const pitch = [
            'Tucaken is a career platform helping engineers land jobs faster with grounded evidence coaching.',
            'Internal note: consider adding a pricing page next quarter.',
            'Another alternate framing for a different audience.',
        ].join('\n\n');
        expect(stampProjectDescription(pitch)).toBe(
            'Tucaken is a career platform helping engineers land jobs faster with grounded evidence coaching.',
        );
    });

    it('long single paragraph -> sentence-capped at capWords, never mid-sentence', () => {
        // 10 sentences of 10 words each = 100 words; cap 80 keeps 8 whole sentences.
        const sentence = (n: number): string => `Sentence number ${n} has exactly ten words in it total.`;
        const pitch = Array.from({ length: 10 }, (_, i) => sentence(i)).join(' ');
        const out = stampProjectDescription(pitch, '', 80);
        const outWords = out.trim().split(/\s+/);
        expect(outWords.length).toBeLessThanOrEqual(80);
        // Never cuts mid-sentence: output ends with sentence punctuation and is a
        // prefix built from whole `sentence()` units.
        expect(out.endsWith('.')).toBe(true);
        expect(pitch.startsWith(out)).toBe(true);
    });

    it('a single run-on sentence (no punctuation) longer than the cap is truncated at the word boundary', () => {
        const pitch = Array.from({ length: 120 }, (_, i) => `word${i}`).join(' ');
        const out = stampProjectDescription(pitch, '', 80);
        expect(out.trim().split(/\s+/)).toHaveLength(80);
        expect(out.endsWith('.')).toBe(true);
    });

    it('default cap is 80 words', () => {
        const words90 = Array.from({ length: 90 }, (_, i) => `word${i}.`).join(' ');
        const out = stampProjectDescription(words90);
        expect(out.trim().split(/\s+/).length).toBeLessThanOrEqual(80);
    });
});

// G3 empty-pitch edge: description falls back pitch -> tagline -> ''.
describe('stampProjectDescription -- tagline fallback (G3)', () => {
    it('empty pitch, non-empty tagline -> tagline is stamped', () => {
        expect(stampProjectDescription('', 'A career platform for engineers.')).toBe(
            'A career platform for engineers.',
        );
    });

    it('whitespace-only pitch, non-empty tagline -> tagline is stamped', () => {
        expect(stampProjectDescription('   \n\n   ', 'A career platform for engineers.')).toBe(
            'A career platform for engineers.',
        );
    });

    it('empty pitch, empty/default tagline -> empty string', () => {
        expect(stampProjectDescription('')).toBe('');
        expect(stampProjectDescription('', '')).toBe('');
    });

    it('non-empty pitch wins over a non-empty tagline -- pitch is the richer text and takes priority', () => {
        expect(stampProjectDescription('The pitch text ships.', 'The tagline never ships.')).toBe(
            'The pitch text ships.',
        );
    });

    it('the tagline fallback gets the SAME first-paragraph + sentence-cap treatment as pitch', () => {
        const tagline = [
            'A short career platform tagline for humans.',
            'Internal note: never ship this second paragraph.',
        ].join('\n\n');
        expect(stampProjectDescription('', tagline)).toBe('A short career platform tagline for humans.');
    });

    it('capWords still applies to the tagline fallback (third positional argument)', () => {
        const sentence = (n: number): string => `Sentence number ${n} has exactly ten words in it total.`;
        const longTagline = Array.from({ length: 10 }, (_, i) => sentence(i)).join(' '); // 100 words
        const out = stampProjectDescription('', longTagline, 80);
        expect(out.trim().split(/\s+/).length).toBeLessThanOrEqual(80);
        expect(out.endsWith('.')).toBe(true);
    });
});
