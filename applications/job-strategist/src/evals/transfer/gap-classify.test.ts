/** @format */
import type { TechTransferGroup } from '@bedrock/shared';
import { classifyGap } from './gap-classify.js';

const typedGroup = (members: string[], transferClass = 'directory-service', transferTier: 'full' | 'partial' = 'full'): TechTransferGroup => ({
    members,
    transferClass,
    transferTier,
    transferBasis: 'shared protocol family',
});

const untypedGroup = (members: string[]): TechTransferGroup => ({
    members,
    transferClass: null,
    transferTier: null,
    transferBasis: null,
});

describe('classifyGap', () => {
    it('classifies a canonical already in the evidenced set as direct-evidence', () => {
        const evidenced = new Set(['terraform']);
        const out = classifyGap('terraform', evidenced, [], new Map());
        expect(out).toEqual({ classification: 'direct-evidence', canonical: 'terraform' });
    });

    it('classifies a gap as transfer-convertible via an evidenced sibling in a typed group', () => {
        const evidenced = new Set(['azure']);
        const groups = [typedGroup(['gcp', 'azure', 'aws'], 'cloud-platform', 'full')];
        const out = classifyGap('gcp', evidenced, groups, new Map());
        expect(out).toEqual({
            classification: 'transfer-convertible',
            canonical:      'gcp',
            via:            'azure',
            transferClass:  'cloud-platform',
            transferTier:   'full',
        });
    });

    it('does NOT convert via an untyped (category-fallback) group even with an evidenced sibling', () => {
        const evidenced = new Set(['python']);
        const groups = [untypedGroup(['python', 'ruby', 'perl'])];
        const out = classifyGap('ruby', evidenced, groups, new Map());
        expect(out).toEqual({ classification: 'honest-gap', canonical: 'ruby' });
    });

    it('classifies a skill with no matching group and no direct evidence as an honest gap', () => {
        const evidenced = new Set(['python']);
        const out = classifyGap('kerberos', evidenced, [], new Map());
        expect(out).toEqual({ classification: 'honest-gap', canonical: 'kerberos' });
    });

    it('resolves an alias to its canonical name before matching evidence (Map alias map)', () => {
        const evidenced = new Set(['active_directory']);
        const aliasMap = new Map([['ad', 'active_directory']]);
        const out = classifyGap('AD', evidenced, [], aliasMap);
        expect(out).toEqual({ classification: 'direct-evidence', canonical: 'active_directory' });
    });

    it('resolves an alias to its canonical name before matching evidence (Record alias map)', () => {
        const evidenced = new Set(['active_directory']);
        const aliasRecord = { ad: 'active_directory' };
        const out = classifyGap('AD', evidenced, [], aliasRecord);
        expect(out).toEqual({ classification: 'direct-evidence', canonical: 'active_directory' });
    });

    it('carries a partial transfer tier through to the classification', () => {
        const evidenced = new Set(['kerberos']);
        const groups = [typedGroup(['ldap', 'kerberos'], 'directory-service', 'partial')];
        const out = classifyGap('ldap', evidenced, groups, new Map());
        expect(out).toEqual({
            classification: 'transfer-convertible',
            canonical:      'ldap',
            via:            'kerberos',
            transferClass:  'directory-service',
            transferTier:   'partial',
        });
    });

    it('falls back to the lowercased skill string when no alias entry exists', () => {
        const evidenced = new Set<string>();
        const out = classifyGap('Some Unmapped Skill', evidenced, [], new Map());
        expect(out.canonical).toBe('some unmapped skill');
        expect(out.classification).toBe('honest-gap');
    });

    it('never picks the canonical itself as its own via (self-reference guard)', () => {
        const evidenced = new Set<string>(); // nothing evidenced at all
        const groups = [typedGroup(['gcp', 'azure'], 'cloud-platform', 'full')];
        const out = classifyGap('gcp', evidenced, groups, new Map());
        expect(out).toEqual({ classification: 'honest-gap', canonical: 'gcp' });
    });
});
