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

describe('resume-unsafe symbols (2026-07-08: ≥/+ shipped in rendered resumes)', () => {
    it('rewrites >= / <= comparisons into words', () => {
        expect(normalizeProse('SonarCloud gate (statements ≥42%, branches ≥60%)'))
            .toBe('SonarCloud gate (statements at least 42%, branches at least 60%)');
        expect(normalizeProse('kept p95 ≤100 ms')).toBe('kept p95 at most 100 ms');
    });

    it('rewrites a digit-trailing plus into words', () => {
        expect(normalizeProse('embedding 265+ CDK test assertions')).toBe('embedding more than 265 CDK test assertions');
        expect(normalizeProse('3+ years')).toBe('more than 3 years');
    });

    it('never touches plus signs that are part of identifiers', () => {
        expect(normalizeProse('C++ and Node.js')).toBe('C++ and Node.js');
        expect(normalizeProse('CI/CD')).toBe('CI/CD');
    });

    it('rewrites arrows into words', () => {
        expect(normalizeProse('recall rose 0.368 → 0.673')).toBe('recall rose 0.368 to 0.673');
    });
});
