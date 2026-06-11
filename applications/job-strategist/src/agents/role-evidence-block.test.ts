/** @format */
import { formatRoleEvidence } from './role-evidence-block.js';
import type { ResolvedRole } from './resolve-role-families.js';

const resolved: ResolvedRole[] = [
    { title: 'Technical Customer Service Associate', company: 'AWS', matchVia: 'alias',
      family: { familyKey: 'technical-support', displayName: 'Technical Support', roleClass: 'customer_facing',
                canonicalResponsibilities: ['Triage queues to SLA'], vocabulary: ['SLA', 'on-call'], transferableSkills: ['customer empathy'], industryNotes: 'AWS support ≈ SaaS support.' } },
    { title: 'Mystery Role', company: 'X', matchVia: 'none', family: null },
];

describe('formatRoleEvidence', () => {
    it('emits a TRANSLATE-framed block with vocabulary, transferable skills, and the industry note', () => {
        const block = formatRoleEvidence(resolved);
        expect(block).toMatch(/TRANSLATE/);
        expect(block).toContain('Technical Customer Service Associate @ AWS');
        expect(block).toContain('SLA');
        expect(block).toContain('customer empathy');
        expect(block).toContain('AWS support ≈ SaaS support.');
    });
    it('skips entries with no family and returns "" when none matched', () => {
        expect(formatRoleEvidence([{ title: 'X', company: 'Y', matchVia: 'none', family: null }])).toBe('');
        expect(formatRoleEvidence(resolved)).not.toContain('Mystery Role');
    });
});
