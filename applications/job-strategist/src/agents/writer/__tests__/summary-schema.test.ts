/** @format */
import { describe, it, expect } from '@jest/globals';
import { SummaryBeatsSchema, assembleSummary } from '../summary-schema.js';

describe('summary schema', () => {
    it('accepts four non-empty beats', () => {
        const ok = SummaryBeatsSchema.safeParse({ s1: 'a', s2: 'b', s3: 'c', s4: 'd' });
        expect(ok.success).toBe(true);
    });
    it('rejects a missing beat', () => {
        const bad = SummaryBeatsSchema.safeParse({ s1: 'a', s2: 'b', s3: 'c' });
        expect(bad.success).toBe(false);
    });
    it('assembles beats into a single spaced string', () => {
        expect(assembleSummary({ s1: 'One.', s2: 'Two.', s3: 'Three.', s4: 'Four.' }))
            .toBe('One. Two. Three. Four.');
    });
});
