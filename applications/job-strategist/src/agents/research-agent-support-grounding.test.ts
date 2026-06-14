/**
 * @format
 * Strategist Research Agent — customer-facing/support-heavy grounding gate.
 *
 * Covers the dimensionMix-driven boost that weights career_history retrieval
 * higher for support-heavy roles: the `isSupportHeavy` gate and the
 * `supportGroundingNote` matcher note. Both are pure — no vector stores touched.
 */

import type {
    isSupportHeavy as IsSupportHeavyFn,
    supportGroundingNote as SupportGroundingNoteFn,
} from './research-agent.js';
import type { JdDimensionMix } from '@bedrock/shared';

// research-agent.ts throws at module load if RESEARCH_MODEL is unset (CDK
// contract). Set it before the dynamic import.
process.env['RESEARCH_MODEL'] = 'eu.anthropic.claude-haiku-4-5-20251001-v1:0';

let isSupportHeavy: typeof IsSupportHeavyFn;
let supportGroundingNote: typeof SupportGroundingNoteFn;

beforeAll(async () => {
    ({ isSupportHeavy, supportGroundingNote } = await import('./research-agent.js'));
});

const mix = (customerFacing: number, supportOps: number): JdDimensionMix => ({
    customerFacing,
    technical: 0,
    aiMl: 0,
    supportOps,
    monitoring: 0,
});

describe('isSupportHeavy (default threshold 40)', () => {
    it('is true exactly at the threshold (customerFacing + supportOps === 40)', () => {
        expect(isSupportHeavy(mix(40, 0))).toBe(true);
        expect(isSupportHeavy(mix(30, 10))).toBe(true);
    });

    it('is false just below the threshold (sum === 39)', () => {
        expect(isSupportHeavy(mix(29, 10))).toBe(false);
        expect(isSupportHeavy(mix(39, 0))).toBe(false);
    });

    it('combines customerFacing and supportOps', () => {
        // OpenAI support JD from run 5a4e5c87: customerFacing 40 + supportOps 10 = 50.
        expect(isSupportHeavy(mix(40, 10))).toBe(true);
    });

    it('fails open for absent / null / zero dimensionMix (behaviour unchanged)', () => {
        expect(isSupportHeavy(undefined)).toBe(false);
        expect(isSupportHeavy(null)).toBe(false);
        expect(isSupportHeavy(mix(0, 0))).toBe(false);
    });

    it('honours an explicit threshold override', () => {
        expect(isSupportHeavy(mix(20, 0), 20)).toBe(true);
        expect(isSupportHeavy(mix(20, 0), 21)).toBe(false);
    });
});

describe('supportGroundingNote', () => {
    it('returns a balanced grounding note at/above threshold, with the weight', () => {
        const note = supportGroundingNote(50);
        expect(note).not.toBe('');
        expect(note).toContain('customer-facing/support-heavy');
        expect(note).toContain('50%');
        // Balance: grounds soft skills in BOTH repo evidence AND career, preferring demonstrated project work.
        expect(note).toMatch(/BOTH/);
        expect(note).toMatch(/PREFER demonstrated project\/repository work/);
        expect(note).toMatch(/career history to corroborate/);
        expect(note).not.toMatch(/PRIMARILY/);
    });

    it('returns empty string below threshold (no note → behaviour unchanged)', () => {
        expect(supportGroundingNote(39)).toBe('');
        expect(supportGroundingNote(0)).toBe('');
    });

    it('honours an explicit threshold override', () => {
        expect(supportGroundingNote(20, 20)).not.toBe('');
        expect(supportGroundingNote(20, 21)).toBe('');
    });
});
