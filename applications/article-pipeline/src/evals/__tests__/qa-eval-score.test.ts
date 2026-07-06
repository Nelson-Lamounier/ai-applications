/** @format */
import { describe, it, expect } from '@jest/globals';
import type { QaValidationResult, DimensionResult } from '@bedrock/shared';

import { scoreQaCase, aggregate, passesGate, formatReport, type QaGoldenCase } from '../qa-eval-score.js';

const clean = (score = 90): DimensionResult => ({ score, issues: [] });

function qaResult(over: Partial<QaValidationResult['dimensions']> = {}, recommendation: QaValidationResult['recommendation'] = 'publish'): QaValidationResult {
    return {
        overallScore: 90,
        recommendation,
        dimensions: {
            technicalAccuracy:    clean(),
            seoCompliance:        clean(),
            mdxStructure:         clean(),
            metadataQuality:      clean(),
            contentQuality:       clean(),
            specificityAndResult: clean(),
            // securityDisclosure (Task 6) isn't part of this eval's golden-case
            // dimension set (QaDimensionKey) yet — that wiring is Task 7 — but
            // the shared QaValidationResult type now requires it on every
            // fixture, so default it clean here.
            securityDisclosure:   clean(),
            ...over,
        },
        summary: 's',
        confidenceOverride: 80,
    };
}

describe('scoreQaCase', () => {
    it('detects a broad-overview article via the specificityAndResult dimension', () => {
        const c: QaGoldenCase = { id: 'broad-overview', expectedFlag: 'specificityAndResult' };
        const r = scoreQaCase(c, qaResult({ specificityAndResult: { score: 40, issues: [] } }, 'revise'));
        expect(r.detected).toBe(true);
        expect(r.flaggedDimensionScore).toBe(40);
    });

    it('detects a planted defect when its dimension scores below threshold', () => {
        const c: QaGoldenCase = { id: 'mdx-broken', expectedFlag: 'mdxStructure' };
        const r = scoreQaCase(c, qaResult({ mdxStructure: { score: 40, issues: [] } }, 'revise'));
        expect(r.detected).toBe(true);
        expect(r.flaggedDimensionScore).toBe(40);
    });

    it('detects a planted defect via an error-severity issue even if score is high', () => {
        const c: QaGoldenCase = { id: 'tech-wrong', expectedFlag: 'technicalAccuracy' };
        const r = scoreQaCase(c, qaResult({
            technicalAccuracy: { score: 95, issues: [{ severity: 'error', location: 'x', description: 'wrong', fix: 'y' }] },
        }));
        expect(r.detected).toBe(true);
    });

    it('misses a planted defect when the QA agent scores the dimension clean (false negative)', () => {
        const c: QaGoldenCase = { id: 'seo-bad', expectedFlag: 'seoCompliance' };
        const r = scoreQaCase(c, qaResult());
        expect(r.detected).toBe(false);
    });

    it('passes the clean control when nothing is flagged and recommendation is publish', () => {
        const r = scoreQaCase({ id: 'clean', expectedFlag: 'none' }, qaResult());
        expect(r.detected).toBe(true);
    });

    it('fails the clean control when the QA agent cries wolf (false positive)', () => {
        const r = scoreQaCase({ id: 'clean', expectedFlag: 'none' }, qaResult({ contentQuality: { score: 50, issues: [] } }, 'revise'));
        expect(r.detected).toBe(false);
    });
});

describe('aggregate + passesGate', () => {
    it('computes accuracy and gates on it', () => {
        const report = aggregate([
            scoreQaCase({ id: 'a', expectedFlag: 'mdxStructure' }, qaResult({ mdxStructure: { score: 30, issues: [] } })),
            scoreQaCase({ id: 'b', expectedFlag: 'none' }, qaResult()),
            scoreQaCase({ id: 'c', expectedFlag: 'seoCompliance' }, qaResult()), // missed
        ]);
        expect(report.detectedCount).toBe(2);
        expect(report.accuracy).toBeCloseTo(2 / 3, 5);
        expect(passesGate(report, 0.6)).toBe(true);
        expect(passesGate(report, 0.9)).toBe(false);
    });
});

describe('formatReport', () => {
    it('renders a table with the header line', () => {
        const out = formatReport(aggregate([scoreQaCase({ id: 'a', expectedFlag: 'none' }, qaResult())]));
        expect(out).toContain('QA-phase eval');
        expect(out).toContain('| case | expected flag | correct | recommendation | dim score |');
    });
});
