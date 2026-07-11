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
        const s = deterministicSummary('Falls short of the 5-year bar. Lacks Kubernetes experience.', 'Platform Engineer');
        expect(namesGap(s)).toBe(false);
        expect(s).toBe("Platform Engineer with proven, evidence-backed delivery across the role's core responsibilities.");
    });

    it('keeps positive sentences and drops only the gap-naming ones', () => {
        const s = deterministicSummary('Strong platform engineering background. Falls short of the 8-year bar.', 'Platform Engineer');
        expect(namesGap(s)).toBe(false);
        expect(s).toBe('Strong platform engineering background.');
    });
});
