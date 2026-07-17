/** @format */
import { isReferenceDoc, vendorGroupForSkill, demoteMisattributedVendors } from '../vendor-provenance.js';
import * as shared from '@bedrock/shared';
import type { ResearchMatching, VerifiedMatch, TechTransferGroup } from '@bedrock/shared';

const CHECKLIST = 'Nelson-Lamounier/ai-applications/docs/checklists/structure-output-checklist.md';
const AUTHORED = 'Nelson-Lamounier/ai-applications/applications/shared/src/llm/bedrock-client.ts';

// openai is interchangeable with claude/anthropic/bedrock (tech-transfer group).
// vendorGroupForSkill still takes plain member arrays (unchanged contract);
// demoteMisattributedVendors takes the typed TechTransferGroup shape.
const GROUPS: string[][] = [['openai', 'claude', 'anthropic', 'bedrock']];
/** Untyped test fixture group — mirrors an ontology component with no relationship-graph metadata. */
const asGroups = (groups: string[][]): TechTransferGroup[] =>
    groups.map((members) => ({ members, transferClass: null, transferTier: null, transferBasis: null }));
const TYPED_GROUPS: TechTransferGroup[] = asGroups(GROUPS);
const ALIAS = new Map<string, string>([
    ['openai api', 'openai'],
    ['chatgpt', 'openai'],
    ['claude', 'claude'],
    ['anthropic', 'anthropic'],
    ['amazon bedrock', 'bedrock'],
]);

const verified = (skill: string, evidenceFiles: string[]): VerifiedMatch => ({
    skill, sourceCitation: 'KB', depth: 'working', recency: '2025', evidenceFiles,
});

// Only verifiedMatches/partialMatches are read by the guard — keep the fixture minimal.
const matching = (verifiedMatches: VerifiedMatch[]): ResearchMatching =>
    ({ verifiedMatches, partialMatches: [] } as unknown as ResearchMatching);

describe('isReferenceDoc', () => {
    it('flags reference/example paths', () => {
        expect(isReferenceDoc(CHECKLIST)).toBe(true);
        expect(isReferenceDoc('repo/docs/examples/openai.py')).toBe(true);
        expect(isReferenceDoc('repo/docs/reference/sdk.md')).toBe(true);
        expect(isReferenceDoc('repo/templates/handler.ts')).toBe(true);
    });
    it('does NOT flag authored source paths', () => {
        expect(isReferenceDoc(AUTHORED)).toBe(false);
        expect(isReferenceDoc('repo/applications/api/src/index.ts')).toBe(false);
        expect(isReferenceDoc('repo/docs/architecture/design.md')).toBe(false);
    });
});

describe('vendorGroupForSkill', () => {
    it('resolves a vendor phrase to its group + siblings', () => {
        const hit = vendorGroupForSkill('OpenAI API and ChatGPT integration', GROUPS, ALIAS);
        expect(hit?.matched).toBe('openai');
        expect(hit?.siblings).toEqual(['claude', 'anthropic', 'bedrock']);
    });
    it('returns null for a non-group skill (e.g. Python)', () => {
        expect(vendorGroupForSkill('Python scripting and automation', GROUPS, ALIAS)).toBeNull();
    });
    it('ignores singleton groups (no sibling to bridge to)', () => {
        expect(vendorGroupForSkill('OpenAI API', [['openai']], ALIAS)).toBeNull();
    });
});

describe('demoteMisattributedVendors', () => {
    it('demotes a competing vendor backed ONLY by a reference doc', () => {
        const r = demoteMisattributedVendors(
            matching([verified('OpenAI API and ChatGPT integration', [CHECKLIST])]),
            { techGroups: TYPED_GROUPS, techAliasMap: ALIAS },
        );
        expect(r.matching.verifiedMatches).toHaveLength(0);
        expect(r.matching.partialMatches).toHaveLength(1);
        expect(r.matching.partialMatches[0].framingSuggestion).toMatch(/Do NOT claim direct production use/i);
        expect(r.matching.partialMatches[0].transferableFoundation).toMatch(/claude/i);
        expect(r.demotions).toEqual([
            { skill: 'OpenAI API and ChatGPT integration', matchedVendor: 'openai', siblings: ['claude', 'anthropic', 'bedrock'], evidenceFiles: [CHECKLIST] },
        ]);
    });

    // Each of these must stay VERIFIED — the demotion must NOT fire.
    it.each([
        ['non-vendor skill cited from the same reference doc (Python stays verified)', 'Python scripting and automation', [CHECKLIST]],
        ['vendor match backed by an AUTHORED source file', 'OpenAI API', [AUTHORED]],
        ['vendor match with mixed evidence (one authored file present)', 'OpenAI API', [CHECKLIST, AUTHORED]],
        ['vendor match with NO evidence files (career evidence, never demoted)', 'OpenAI API', []],
    ])('KEEPS a %s', (_label, skill, files) => {
        const r = demoteMisattributedVendors(
            matching([verified(skill, files)]),
            { techGroups: TYPED_GROUPS, techAliasMap: ALIAS },
        );
        expect(r.matching.verifiedMatches).toHaveLength(1);
        expect(r.demotions).toHaveLength(0);
    });

    it('only demotes the offending row; leaves other verified matches intact', () => {
        const r = demoteMisattributedVendors(
            matching([
                verified('Python scripting and automation', [CHECKLIST]),
                verified('OpenAI API and ChatGPT integration', [CHECKLIST]),
                verified('SaaS troubleshooting', []),
            ]),
            { techGroups: TYPED_GROUPS, techAliasMap: ALIAS },
        );
        expect(r.matching.verifiedMatches.map((v) => v.skill).sort((a, b) => a.localeCompare(b)))
            .toEqual(['Python scripting and automation', 'SaaS troubleshooting']);
        expect(r.matching.partialMatches).toHaveLength(1);
        expect(r.demotions).toHaveLength(1);
    });

    it('FAIL-SAFE: no tech groups → input returned unchanged', () => {
        const input = matching([verified('OpenAI API', [CHECKLIST])]);
        const r = demoteMisattributedVendors(input, { techGroups: [], techAliasMap: ALIAS });
        expect(r.matching).toBe(input);
        expect(r.demotions).toHaveLength(0);
    });

    describe('fail-open telemetry', () => {
        it('warns when SKIPPED because techGroups is empty (possible ontology load failure)', () => {
            const warnSpy = jest.spyOn(shared, 'log').mockImplementation(() => undefined);
            demoteMisattributedVendors(matching([verified('OpenAI API', [CHECKLIST])]), { techGroups: [], techAliasMap: ALIAS });
            expect(warnSpy).toHaveBeenCalledWith('WARN', expect.stringMatching(/skipped/i), expect.any(Object));
            warnSpy.mockRestore();
        });

        it('does NOT warn when the guard RAN and found 0 demotions', () => {
            const warnSpy = jest.spyOn(shared, 'log').mockImplementation(() => undefined);
            const r = demoteMisattributedVendors(
                matching([verified('Python scripting and automation', [CHECKLIST])]),
                { techGroups: TYPED_GROUPS, techAliasMap: ALIAS },
            );
            expect(r.demotions).toHaveLength(0);
            expect(warnSpy).not.toHaveBeenCalled();
            warnSpy.mockRestore();
        });
    });

    describe('absent-from-code cross-check (robust where the path heuristic misses)', () => {
        const codeWith = (...techs: string[]) =>
            new Map<string, ReadonlySet<string>>([['Nelson-Lamounier/ai-applications', new Set(techs)]]);

        it('demotes a vendor backed by an AUTHORED doc when the vendor is absent from code but a sibling is present', () => {
            // Claims OpenAI from a normal (non-reference) doc, but the code uses Bedrock.
            const r = demoteMisattributedVendors(
                matching([verified('OpenAI API and ChatGPT integration', [AUTHORED])]),
                { techGroups: TYPED_GROUPS, techAliasMap: ALIAS, codeTechByRepo: codeWith('bedrock', 'typescript') },
            );
            expect(r.matching.verifiedMatches).toHaveLength(0);
            expect(r.matching.partialMatches).toHaveLength(1);
            expect(r.matching.partialMatches[0].gapDescription).toMatch(/not present in the candidate's authored code/i);
        });

        it('lists ONLY the code-present alternatives in the bridge — drops group noise (aws_vpc)', () => {
            const noisyGroup: TechTransferGroup[] = asGroups([['openai', 'claude', 'bedrock', 'aws_vpc']]);
            const r = demoteMisattributedVendors(
                matching([verified('OpenAI API', [AUTHORED])]),
                { techGroups: noisyGroup, techAliasMap: ALIAS, codeTechByRepo: codeWith('bedrock') },
            );
            const bridge = r.matching.partialMatches[0].transferableFoundation;
            expect(bridge).toMatch(/bedrock/i);
            expect(bridge).not.toMatch(/aws vpc/i); // group member, not in code → excluded
            expect(bridge).not.toMatch(/claude/i);  // group member, not in code → excluded
        });

        it('KEEPS a vendor that IS in the candidate code (real production use)', () => {
            const r = demoteMisattributedVendors(
                matching([verified('OpenAI API', [AUTHORED])]),
                { techGroups: TYPED_GROUPS, techAliasMap: ALIAS, codeTechByRepo: codeWith('openai', 'bedrock') },
            );
            expect(r.matching.verifiedMatches).toHaveLength(1);
            expect(r.demotions).toHaveLength(0);
        });

        it('KEEPS a vendor absent from code when NO sibling is in code (no transferable bridge — could be undetectable)', () => {
            const r = demoteMisattributedVendors(
                matching([verified('OpenAI API', [AUTHORED])]),
                { techGroups: TYPED_GROUPS, techAliasMap: ALIAS, codeTechByRepo: codeWith('python', 'kubernetes') },
            );
            expect(r.matching.verifiedMatches).toHaveLength(1);
            expect(r.demotions).toHaveLength(0);
        });
    });
});
