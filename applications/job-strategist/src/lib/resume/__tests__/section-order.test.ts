/** @format */
import { describe, expect, it } from '@jest/globals';

import { CANONICAL_SECTION_ORDER, stampCanonicalSectionOrder } from '../section-order.js';

describe('CANONICAL_SECTION_ORDER', () => {
    it('places skills after certifications (user decision, 2026-07-16)', () => {
        expect(CANONICAL_SECTION_ORDER).toEqual([
            'summary',
            'experience',
            'projects',
            'education',
            'certifications',
            'skills',
        ]);
    });
});

describe('stampCanonicalSectionOrder', () => {
    it('overwrites a model-echoed order (the live regression shape)', () => {
        const resume = {
            summary: 's',
            sectionOrder: ['profile', 'summary', 'experience', 'skills', 'projects', 'education', 'certifications'],
        };
        expect(stampCanonicalSectionOrder(resume).sectionOrder).toEqual([...CANONICAL_SECTION_ORDER]);
    });

    it('stamps the order when none is present and leaves other fields intact', () => {
        const resume = { summary: 's', experience: [{ title: 't' }] };
        const stamped = stampCanonicalSectionOrder(resume);
        expect(stamped.sectionOrder).toEqual([...CANONICAL_SECTION_ORDER]);
        expect(stamped.summary).toBe('s');
        expect(stamped.experience).toEqual([{ title: 't' }]);
    });

    it('returns a copy carrying a fresh array (no shared mutable state)', () => {
        const resume = { summary: 's' };
        const a = stampCanonicalSectionOrder(resume);
        const b = stampCanonicalSectionOrder(resume);
        expect(a).not.toBe(resume);
        expect(a.sectionOrder).not.toBe(b.sectionOrder);
    });
});
