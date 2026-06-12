/** @format */
import { buildSkillEvidenceLedger } from './skill-evidence-ledger.js';
import type { VerifiedMatch, PartialMatch } from '@bedrock/shared';

const makeVerified = (overrides: Partial<VerifiedMatch> & Pick<VerifiedMatch, 'skill'>): VerifiedMatch => ({
    sourceCitation: 'some project',
    depth: 'working',
    recency: '2025',
    evidenceFiles: [],
    ...overrides,
});

const makePartial = (overrides: Partial<PartialMatch> & Pick<PartialMatch, 'skill'>): PartialMatch => ({
    gapDescription: 'limited exposure',
    transferableFoundation: 'related experience',
    framingSuggestion: 'frame as transferable',
    evidenceFiles: [],
    ...overrides,
});

describe('buildSkillEvidenceLedger', () => {
    it('tool with a verifiedMatch → status verified + sourceCitation as evidence + evidenceFiles', () => {
        const matching = {
            verifiedMatches: [
                makeVerified({
                    skill: 'Python',
                    sourceCitation: 'ai-applications — scripting pipeline',
                    evidenceFiles: ['Nelson-Lamounier/ai-applications/scripts/run.py'],
                }),
            ],
            partialMatches: [],
        };
        const ledger = buildSkillEvidenceLedger(['Python'], matching);
        expect(ledger).toHaveLength(1);
        expect(ledger[0]).toEqual({
            tool: 'Python',
            status: 'verified',
            evidenceFiles: ['Nelson-Lamounier/ai-applications/scripts/run.py'],
            evidence: 'ai-applications — scripting pipeline',
            transferableBridge: '',
        });
    });

    it('tool with a partialMatch only → status transferable + bridge + evidenceFiles', () => {
        const matching = {
            verifiedMatches: [],
            partialMatches: [
                makePartial({
                    skill: 'GraphQL',
                    gapDescription: 'Used REST APIs extensively',
                    transferableFoundation: 'Strong API design understanding',
                    evidenceFiles: ['Nelson-Lamounier/repo/src/api/rest.ts'],
                }),
            ],
        };
        const ledger = buildSkillEvidenceLedger(['GraphQL'], matching);
        expect(ledger).toHaveLength(1);
        expect(ledger[0]).toEqual({
            tool: 'GraphQL',
            status: 'transferable',
            evidenceFiles: ['Nelson-Lamounier/repo/src/api/rest.ts'],
            evidence: 'Used REST APIs extensively',
            transferableBridge: 'Strong API design understanding',
        });
    });

    it('unmatched tool → status gap + empty evidenceFiles + empty strings', () => {
        const matching = {
            verifiedMatches: [],
            partialMatches: [],
        };
        const ledger = buildSkillEvidenceLedger(['Rust'], matching);
        expect(ledger).toHaveLength(1);
        expect(ledger[0]).toEqual({
            tool: 'Rust',
            status: 'gap',
            evidenceFiles: [],
            evidence: '',
            transferableBridge: '',
        });
    });

    it('deduplicates tools case-insensitively — first occurrence wins', () => {
        const matching = {
            verifiedMatches: [
                makeVerified({ skill: 'Python', sourceCitation: 'pipeline', evidenceFiles: ['a.py'] }),
            ],
            partialMatches: [],
        };
        const ledger = buildSkillEvidenceLedger(['Python', 'python', 'PYTHON'], matching);
        expect(ledger).toHaveLength(1);
        expect(ledger[0]!.tool).toBe('Python');
        expect(ledger[0]!.status).toBe('verified');
    });

    it('preserves input tool order', () => {
        const matching = {
            verifiedMatches: [
                makeVerified({ skill: 'TypeScript' }),
                makeVerified({ skill: 'AWS CDK' }),
            ],
            partialMatches: [],
        };
        const ledger = buildSkillEvidenceLedger(['AWS CDK', 'TypeScript', 'Rust'], matching);
        expect(ledger.map((e) => e.tool)).toEqual(['AWS CDK', 'TypeScript', 'Rust']);
    });

    it('Python matches a verifiedMatch skill "Scripting and automation (Python/Bash)"', () => {
        const matching = {
            verifiedMatches: [
                makeVerified({
                    skill: 'Scripting and automation (Python/Bash)',
                    sourceCitation: 'automation pipeline',
                    evidenceFiles: ['repo/scripts/run.sh'],
                }),
            ],
            partialMatches: [],
        };
        const ledger = buildSkillEvidenceLedger(['Python'], matching);
        expect(ledger).toHaveLength(1);
        expect(ledger[0]!.status).toBe('verified');
        expect(ledger[0]!.evidenceFiles).toEqual(['repo/scripts/run.sh']);
    });

    it('empty tools array → empty ledger', () => {
        const matching = {
            verifiedMatches: [makeVerified({ skill: 'Python' })],
            partialMatches: [],
        };
        expect(buildSkillEvidenceLedger([], matching)).toEqual([]);
    });

    it('verifiedMatch takes precedence over partialMatch for the same tool', () => {
        const matching = {
            verifiedMatches: [
                makeVerified({ skill: 'Docker', sourceCitation: 'container project', evidenceFiles: ['Dockerfile'] }),
            ],
            partialMatches: [
                makePartial({ skill: 'Docker', gapDescription: 'some gap', evidenceFiles: ['other.ts'] }),
            ],
        };
        const ledger = buildSkillEvidenceLedger(['Docker'], matching);
        expect(ledger[0]!.status).toBe('verified');
        expect(ledger[0]!.evidenceFiles).toEqual(['Dockerfile']);
    });
});

// ---------------------------------------------------------------------------
// A4 — Ledger transferable-via-group
// ---------------------------------------------------------------------------

const aiProviderGroup = ['anthropic_claude', 'openai', 'aws_bedrock', 'chatgpt', 'codex'];
const techGroups = [aiProviderGroup];
const techAliasMap = new Map<string, string>([
    ['openai api', 'openai'],
    ['openai', 'openai'],
    ['chatgpt', 'chatgpt'],
    ['codex', 'codex'],
    ['anthropic claude', 'anthropic_claude'],
    ['claude', 'anthropic_claude'],
    ['aws bedrock', 'aws_bedrock'],
    ['bedrock', 'aws_bedrock'],
    ['amazon bedrock', 'aws_bedrock'],
]);

describe('buildSkillEvidenceLedger — tech-group transferable (A4)', () => {
    it('tool with no direct match but verified sibling in same group → transferable with bridge', () => {
        const matching = {
            verifiedMatches: [
                makeVerified({
                    skill: 'AWS Bedrock',
                    sourceCitation: 'Bedrock/Claude integration in ai-applications',
                    evidenceFiles: ['Nelson-Lamounier/ai-applications/src/bedrock-client.ts'],
                }),
            ],
            partialMatches: [],
        };
        const ledger = buildSkillEvidenceLedger(['OpenAI API'], matching, { techGroups, techAliasMap });
        expect(ledger).toHaveLength(1);
        const entry = ledger[0]!;
        expect(entry.status).toBe('transferable');
        expect(entry.evidenceFiles).toEqual(['Nelson-Lamounier/ai-applications/src/bedrock-client.ts']);
        expect(entry.evidence).toBe('Bedrock/Claude integration in ai-applications');
        expect(entry.transferableBridge).toMatch(/same technology group/i);
        expect(entry.transferableBridge).toMatch(/aws bedrock/i);
        expect(entry.transferableBridge).toMatch(/openai api/i);
    });

    it('true gap tool with no group-sibling verified evidence → remains gap (honesty)', () => {
        const matching = {
            verifiedMatches: [
                makeVerified({
                    skill: 'AWS Bedrock',
                    sourceCitation: 'bedrock project',
                    evidenceFiles: ['bedrock-client.ts'],
                }),
            ],
            partialMatches: [],
        };
        // Salesforce is NOT in the aiProviderGroup
        const ledger = buildSkillEvidenceLedger(['Salesforce'], matching, { techGroups, techAliasMap });
        expect(ledger).toHaveLength(1);
        const entry = ledger[0]!;
        expect(entry.status).toBe('gap');
        expect(entry.evidenceFiles).toEqual([]);
        expect(entry.evidence).toBe('');
        expect(entry.transferableBridge).toBe('');
    });

    it('verified direct match always wins over group-based transferable', () => {
        const matching = {
            verifiedMatches: [
                makeVerified({
                    skill: 'OpenAI API',
                    sourceCitation: 'direct openai usage',
                    evidenceFiles: ['openai-client.ts'],
                }),
            ],
            partialMatches: [],
        };
        const ledger = buildSkillEvidenceLedger(['OpenAI API'], matching, { techGroups, techAliasMap });
        expect(ledger[0]!.status).toBe('verified');
        expect(ledger[0]!.evidenceFiles).toEqual(['openai-client.ts']);
    });

    it('partial direct match wins over group-based transferable', () => {
        const matching = {
            verifiedMatches: [],
            partialMatches: [
                makePartial({
                    skill: 'OpenAI API',
                    gapDescription: 'limited openai exposure',
                    transferableFoundation: 'api design knowledge',
                    evidenceFiles: ['some-api.ts'],
                }),
            ],
        };
        // Even though AWS Bedrock is NOT in verifiedMatches, the partial direct match wins
        const ledger = buildSkillEvidenceLedger(['OpenAI API'], matching, { techGroups, techAliasMap });
        expect(ledger[0]!.status).toBe('transferable');
        expect(ledger[0]!.transferableBridge).toBe('api design knowledge');
    });

    it('omitting opts entirely preserves original behaviour (back-compat)', () => {
        const matching = {
            verifiedMatches: [
                makeVerified({ skill: 'AWS Bedrock', sourceCitation: 'bedrock project', evidenceFiles: ['f.ts'] }),
            ],
            partialMatches: [],
        };
        // Without opts, OpenAI API has no direct match → gap (no group resolution)
        const ledger = buildSkillEvidenceLedger(['OpenAI API'], matching);
        expect(ledger[0]!.status).toBe('gap');
    });

    it('group-transferable picks the first verified sibling match when multiple exist', () => {
        const matching = {
            verifiedMatches: [
                makeVerified({
                    skill: 'AWS Bedrock',
                    sourceCitation: 'bedrock first',
                    evidenceFiles: ['bedrock.ts'],
                }),
                makeVerified({
                    skill: 'Claude',
                    sourceCitation: 'claude second',
                    evidenceFiles: ['claude.ts'],
                }),
            ],
            partialMatches: [],
        };
        const ledger = buildSkillEvidenceLedger(['OpenAI API'], matching, { techGroups, techAliasMap });
        expect(ledger[0]!.status).toBe('transferable');
        // First sibling found wins
        expect(ledger[0]!.evidence).toBe('bedrock first');
    });
});
