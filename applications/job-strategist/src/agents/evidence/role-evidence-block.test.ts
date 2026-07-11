/** @format */
import { formatRoleEvidence } from './role-evidence-block.js';
import type { CompanyType } from '@bedrock/shared';
import type { ResolvedRole } from '../jd/resolve-role-families.js';

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
    it('company-type framing overrides familiy industryNotes when a matching framing entry exists', () => {
        const infraRole: ResolvedRole = {
            title: 'Cloud Support Engineer', company: 'AWS', matchVia: 'classifier',
            companyType: 'infra_provider' as CompanyType,
            family: { familyKey: 'technical-support', displayName: 'Technical Support', roleClass: 'customer_facing',
                      canonicalResponsibilities: ['Triage'], vocabulary: ['SLA'], transferableSkills: ['empathy'], industryNotes: 'old note' },
        };
        const framing = new Map<CompanyType, string>([['infra_provider', 'like SaaS']]);
        const block = formatRoleEvidence([infraRole], framing);
        expect(block).toContain('note: like SaaS');
        expect(block).not.toContain('old note');
    });
    it('falls back to industryNotes when companyType is not in the framing map', () => {
        const block = formatRoleEvidence(resolved, new Map());
        expect(block).toContain('AWS support ≈ SaaS support.');
    });
    it('falls back to industryNotes when the matched framing is empty (e.g. company_type "other")', () => {
        const otherRole: ResolvedRole = {
            title: 'Support Rep', company: 'SomeCo', matchVia: 'classifier', companyType: 'other' as CompanyType,
            family: { familyKey: 'technical-support', displayName: 'Technical Support', roleClass: 'customer_facing',
                      canonicalResponsibilities: ['Triage'], vocabulary: ['SLA'], transferableSkills: ['empathy'], industryNotes: 'family fallback note' },
        };
        const framing = new Map<CompanyType, string>([['other', '']]); // empty framing must NOT suppress the family note
        const block = formatRoleEvidence([otherRole], framing);
        expect(block).toContain('note: family fallback note');
    });
});
