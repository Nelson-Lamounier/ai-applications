/** @format */
import { describe, it, expect } from '@jest/globals';
import { deterministicSummary } from '../summary-fallback.js';
import { namesGap } from '../../quality/guards/summary-rules.js';

describe('deterministic summary fallback', () => {
    it('strips gap language so the guard accepts it', () => {
        const s = deterministicSummary('Reasonable fit but falls short of the 8-year bar and lacks Go.', 'Backend Engineer');
        expect(namesGap(s)).toBe(false);
        expect(s.length).toBeGreaterThan(0);
    });

    it('falls back to a role-based positioning line when every sentence names a gap', () => {
        const s = deterministicSummary('Falls short of the 5-year bar. Does not yet have Kubernetes experience.', 'Platform Engineer');
        expect(namesGap(s)).toBe(false);
        expect(s).toBe("Platform Engineer with proven, evidence-backed delivery across the role's core responsibilities.");
    });

    it('keeps positive sentences and drops only the gap-naming ones', () => {
        const s = deterministicSummary('Strong platform engineering background. Falls short of the 8-year bar.', 'Platform Engineer');
        expect(namesGap(s)).toBe(false);
        expect(s).toBe('Strong platform engineering background.');
    });

    it('strips a years/bar/threshold/requirement gap pattern the old regex missed', () => {
        const s = deterministicSummary('Meets 3 of the 8 years required against this bar for the role.', 'Backend Engineer');
        expect(namesGap(s)).toBe(false);
        expect(s.length).toBeGreaterThan(0);
    });

    it('falls back to the generic default when every sentence names a gap via the years pattern', () => {
        const s = deterministicSummary('Meets 3 of the 8 years required against this bar. Falls short of the Go requirement.', 'Backend Engineer');
        expect(namesGap(s)).toBe(false);
        expect(s.length).toBeGreaterThan(0);
        expect(s).toBe("Backend Engineer with proven, evidence-backed delivery across the role's core responsibilities.");
    });
});
