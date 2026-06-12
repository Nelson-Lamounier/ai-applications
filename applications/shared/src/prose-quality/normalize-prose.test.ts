/** @format */
import { normalizeProse } from './normalize-prose.js';

describe('normalizeProse', () => {
    it('replaces em-dashes with commas', () => {
        expect(normalizeProse('Removed 20 hrs/week — the biggest support win')).toBe('Removed 20 hrs/week, the biggest support win');
        expect(normalizeProse('drove adoption — and authored the ROI case — across EMEA')).toBe('drove adoption, and authored the ROI case, across EMEA');
        expect(normalizeProse('word—word')).toBe('word, word');
    });
    it('preserves en-dashes (date ranges) and the middot', () => {
        expect(normalizeProse('Dublin Business School · 2021–2024')).toBe('Dublin Business School · 2021–2024');
        expect(normalizeProse('Technical Support Engineer · Cloud & AI Operations')).toBe('Technical Support Engineer · Cloud & AI Operations');
    });
    it('cleans up an em-dash before a period', () => {
        expect(normalizeProse('it shipped — .')).toBe('it shipped.');
    });
    it('no-op on clean text / empty', () => {
        expect(normalizeProse('Support engineer who ships production AI.')).toBe('Support engineer who ships production AI.');
        expect(normalizeProse('')).toBe('');
    });
});
