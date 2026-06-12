import { describe, it, expect } from '@jest/globals';
import { RESUME_CONSTRAINTS } from './resume-constraints.js';

const text = RESUME_CONSTRAINTS;

describe('resume-constraints F-pattern rules', () => {
    describe('Step 1 — support summary opener no longer hardcodes infra-first identity', () => {
        it('contains the lead identity rule for support archetype', () => {
            const hasLeadIdentity =
                text.includes('lead identity') ||
                text.includes('Support engineer who builds production AI');
            expect(hasLeadIdentity).toBe(true);
        });

        it('contains an explicit prohibition on infrastructure-first opener for support', () => {
            const hasNeverInfra =
                text.includes('NEVER an infrastructure-first') ||
                text.toLowerCase().includes('never an infrastructure-first');
            expect(hasNeverInfra).toBe(true);
        });

        it('does NOT retain the old hardcoded "Cloud infrastructure engineer with [N] years triaging" as the only support variant', () => {
            // The old text was the ONLY variant — it must no longer be the opener rule.
            // The new rule replaces it; the old verbatim string is gone.
            expect(text).not.toContain(
                '"Cloud infrastructure engineer with [N] years triaging enterprise [domain] escalations'
            );
        });
    });

    describe('Step 2 — skills ordering rule', () => {
        it('contains Support & Troubleshooting as the required lead skill group', () => {
            expect(text).toContain('Support & Troubleshooting');
        });
    });

    describe('Step 3 — experience lead-bullet rule', () => {
        it('contains the LEAD BULLET rule', () => {
            const hasLeadBullet =
                text.includes('LEAD BULLET') ||
                text.toLowerCase().includes('strongest number-led');
            expect(hasLeadBullet).toBe(true);
        });
    });

    describe('Step 4 — projects collapse rule', () => {
        it('contains the PROJECTS COLLAPSE rule', () => {
            const hasCollapse =
                text.includes('PROJECTS COLLAPSE') ||
                text.includes('Selected work:');
            expect(hasCollapse).toBe(true);
        });

        it('places the Selected-work line under the BUILDER/engineering role, never support/customer/QA', () => {
            expect(text).toContain('BUILDER/engineering role');
            expect(text).toContain('NEVER under a customer-facing / support / QA role');
        });
    });

    describe('Step 5 — education ordering rule', () => {
        it('contains the EDUCATION ORDER rule', () => {
            const hasEducationOrder =
                text.includes('EDUCATION ORDER') ||
                text.includes('relevance-then-recency');
            expect(hasEducationOrder).toBe(true);
        });
    });
});
