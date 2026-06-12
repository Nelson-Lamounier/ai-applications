/** @format */
import { isReferenceDoc, vendorGroupForSkill, demoteMisattributedVendors } from './vendor-provenance.js';
import type { ResearchMatching, VerifiedMatch } from '@bedrock/shared';

const CHECKLIST = 'Nelson-Lamounier/ai-applications/docs/checklists/structure-output-checklist.md';
const AUTHORED = 'Nelson-Lamounier/ai-applications/applications/shared/src/llm/bedrock-client.ts';

// openai is interchangeable with claude/anthropic/bedrock (tech-transfer group).
const GROUPS: string[][] = [['openai', 'claude', 'anthropic', 'bedrock']];
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
            { techGroups: GROUPS, techAliasMap: ALIAS },
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
            { techGroups: GROUPS, techAliasMap: ALIAS },
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
            { techGroups: GROUPS, techAliasMap: ALIAS },
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
});
