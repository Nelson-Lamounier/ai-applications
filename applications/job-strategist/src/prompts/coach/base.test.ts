/** @format */
import { COACH_BASE_TEXT } from './base.js';

describe('COACH_BASE_TEXT', () => {
    it('keeps the truthfulness mandate', () => {
        expect(COACH_BASE_TEXT).toContain('TRUTHFULNESS MANDATE');
        expect(COACH_BASE_TEXT).toContain('NEVER fabricate');
    });
    it('keeps ESL coaching guidance', () => {
        expect(COACH_BASE_TEXT).toContain('ESL');
    });
    it('drops the stale output-example fields', () => {
        expect(COACH_BASE_TEXT).not.toContain('kbCoverage');
        expect(COACH_BASE_TEXT).not.toContain('conceptExplanation');
        expect(COACH_BASE_TEXT).not.toContain('kbCoverageReport');
    });
    it('carries no per-stage branch headers (those live in stage files)', () => {
        expect(COACH_BASE_TEXT).not.toContain('STAGE 1: BEHAVIOURAL');
        expect(COACH_BASE_TEXT).not.toContain('STAGE 2: TECHNICAL');
    });
});
