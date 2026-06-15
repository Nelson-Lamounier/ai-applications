/** @format */
import { buildSkillEvidenceLedger } from './skill-evidence-ledger.js';
import type { VerifiedMatch, PartialMatch, SkillGap } from '@bedrock/shared';

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

const makeGap = (overrides: Partial<SkillGap> & Pick<SkillGap, 'skill'>): SkillGap => ({
    gapType: 'soft',
    impactSeverity: 'minor',
    disqualifyingAssessment: 'not disqualifying',
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
            gaps: [],
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
            gaps: [],
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

    it('tool matching a real matcher GAP → status gap + empty evidenceFiles + empty strings', () => {
        const matching = {
            verifiedMatches: [],
            partialMatches: [],
            gaps: [makeGap({ skill: 'Rust' })],
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

    it('tool matching NOTHING (not verified, not partial, not a matcher gap) → transferable (implied), NOT a false gap', () => {
        const matching = {
            verifiedMatches: [],
            partialMatches: [],
            gaps: [],
        };
        const ledger = buildSkillEvidenceLedger(['Rust'], matching);
        // Matched nothing the matcher assessed → DROPPED (no contentless row).
        expect(ledger).toHaveLength(0);
    });

    it('deduplicates tools case-insensitively — first occurrence wins', () => {
        const matching = {
            verifiedMatches: [
                makeVerified({ skill: 'Python', sourceCitation: 'pipeline', evidenceFiles: ['a.py'] }),
            ],
            partialMatches: [],
            gaps: [],
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
            gaps: [],
        };
        const ledger = buildSkillEvidenceLedger(['AWS CDK', 'TypeScript', 'Rust'], matching);
        // 'Rust' matched nothing → dropped; order of the rest preserved.
        expect(ledger.map((e) => e.tool)).toEqual(['AWS CDK', 'TypeScript']);
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
            gaps: [],
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
            gaps: [],
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
            gaps: [],
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
            gaps: [],
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

    it('true gap tool with no group-sibling verified evidence but a matching matcher gap → remains gap (honesty)', () => {
        const matching = {
            verifiedMatches: [
                makeVerified({
                    skill: 'AWS Bedrock',
                    sourceCitation: 'bedrock project',
                    evidenceFiles: ['bedrock-client.ts'],
                }),
            ],
            partialMatches: [],
            // The matcher flagged Salesforce as a real gap — so it stays gap.
            gaps: [makeGap({ skill: 'Salesforce' })],
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
            gaps: [],
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
            gaps: [],
        };
        // Even though AWS Bedrock is NOT in verifiedMatches, the partial direct match wins
        const ledger = buildSkillEvidenceLedger(['OpenAI API'], matching, { techGroups, techAliasMap });
        expect(ledger[0]!.status).toBe('transferable');
        expect(ledger[0]!.transferableBridge).toBe('api design knowledge');
    });

    it('omitting opts: no group resolution; tool matching a matcher gap → gap', () => {
        const matching = {
            verifiedMatches: [
                makeVerified({ skill: 'AWS Bedrock', sourceCitation: 'bedrock project', evidenceFiles: ['f.ts'] }),
            ],
            partialMatches: [],
            // The matcher flagged OpenAI API as a real gap.
            gaps: [makeGap({ skill: 'OpenAI API' })],
        };
        // Without opts, OpenAI API has no group resolution; it matches a real matcher gap → gap
        const ledger = buildSkillEvidenceLedger(['OpenAI API'], matching);
        expect(ledger[0]!.status).toBe('gap');
    });

    it('omitting opts: tool matching NOTHING (no group, no matcher gap) → DROPPED', () => {
        const matching = {
            verifiedMatches: [
                makeVerified({ skill: 'AWS Bedrock', sourceCitation: 'bedrock project', evidenceFiles: ['f.ts'] }),
            ],
            partialMatches: [],
            gaps: [],
        };
        // Without opts and with no matching matcher gap, OpenAI API matches nothing → dropped.
        const ledger = buildSkillEvidenceLedger(['OpenAI API'], matching);
        expect(ledger).toHaveLength(0);
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
            gaps: [],
        };
        const ledger = buildSkillEvidenceLedger(['OpenAI API'], matching, { techGroups, techAliasMap });
        expect(ledger[0]!.status).toBe('transferable');
        // First sibling found wins
        expect(ledger[0]!.evidence).toBe('bedrock first');
    });
});

// ---------------------------------------------------------------------------
// Grounding accuracy — ledger status aligns with the matcher (token-overlap
// bridges competency phrasing; gap ONLY when it matches a real matcher gap).
// Run 5a4e5c87: verified competencies were being re-gapped by literal matching.
// ---------------------------------------------------------------------------

describe('buildSkillEvidenceLedger — token-overlap bridging + matcher-aligned gaps', () => {
    it('"Critical thinking and root cause analysis" + verified "...root-cause analysis" → verified (token-overlap)', () => {
        const matching = {
            verifiedMatches: [
                makeVerified({
                    skill: 'SaaS support operations, escalation management, root-cause analysis',
                    sourceCitation: 'incident runbooks in ai-applications',
                    evidenceFiles: ['Nelson-Lamounier/ai-applications/docs/runbooks/escalation.md'],
                }),
            ],
            partialMatches: [],
            gaps: [],
        };
        const ledger = buildSkillEvidenceLedger(['Critical thinking and root cause analysis'], matching);
        expect(ledger[0]!.status).toBe('verified');
        expect(ledger[0]!.evidenceFiles).toEqual(['Nelson-Lamounier/ai-applications/docs/runbooks/escalation.md']);
        expect(ledger[0]!.evidence).toBe('incident runbooks in ai-applications');
    });

    it('"Direct customer support and relationship building" + verified "Direct customer support / customer interaction" → verified', () => {
        const matching = {
            verifiedMatches: [
                makeVerified({
                    skill: 'Direct customer support / customer interaction',
                    sourceCitation: 'support role evidence',
                    evidenceFiles: ['career/support-role.md'],
                }),
            ],
            partialMatches: [],
            gaps: [],
        };
        const ledger = buildSkillEvidenceLedger(['Direct customer support and relationship building'], matching);
        expect(ledger[0]!.status).toBe('verified');
        expect(ledger[0]!.evidenceFiles).toEqual(['career/support-role.md']);
    });

    it('"8+ years experience" + matcher gap "8+ years user operations experience" → gap (the real gap stays gap)', () => {
        const matching = {
            verifiedMatches: [],
            partialMatches: [],
            gaps: [makeGap({ skill: '8+ years user operations experience' })],
        };
        const ledger = buildSkillEvidenceLedger(['8+ years experience'], matching);
        expect(ledger[0]).toEqual({
            tool: '8+ years experience',
            status: 'gap',
            evidenceFiles: [],
            evidence: '',
            transferableBridge: '',
        });
    });

    it('"Problem solving" with NO verified/partial/gap match → DROPPED (no contentless row)', () => {
        const matching = {
            verifiedMatches: [
                makeVerified({ skill: 'AWS Bedrock', sourceCitation: 'bedrock', evidenceFiles: ['b.ts'] }),
            ],
            partialMatches: [],
            gaps: [makeGap({ skill: '8+ years user operations experience' })],
        };
        const ledger = buildSkillEvidenceLedger(['Problem solving'], matching);
        expect(ledger).toHaveLength(0);
    });

    it('a tool matching BOTH a verified and a matcher gap resolves to verified (verified checked first)', () => {
        const matching = {
            verifiedMatches: [
                makeVerified({
                    skill: 'root-cause analysis and escalation management',
                    sourceCitation: 'verified evidence',
                    evidenceFiles: ['rca.md'],
                }),
            ],
            partialMatches: [],
            // The matcher ALSO listed a gap that token-overlaps "root cause analysis"
            gaps: [makeGap({ skill: 'formal root cause analysis certification' })],
        };
        const ledger = buildSkillEvidenceLedger(['Critical thinking and root cause analysis'], matching);
        expect(ledger[0]!.status).toBe('verified');
        expect(ledger[0]!.evidenceFiles).toEqual(['rca.md']);
    });

    it('bridgeable gap: a tool matching BOTH a partialMatch and a matcher gap resolves to GAP, keeping the foundation as the bridge', () => {
        const matching = {
            verifiedMatches: [],
            // The matcher (often Haiku) listed the SAME skill in both partial AND gap.
            partialMatches: [
                makePartial({
                    skill: 'OpenAI API (explicit mention in JD)',
                    transferableFoundation: 'LLM API patterns are fungible — your Bedrock/Claude work transfers',
                    evidenceFiles: ['me/repo/invoke-claude.ts'],
                }),
            ],
            gaps: [makeGap({ skill: 'OpenAI API, ChatGPT (explicit named technologies in JD)' })],
        };
        const ledger = buildSkillEvidenceLedger(['OpenAI API'], matching);
        expect(ledger).toHaveLength(1);
        expect(ledger[0]).toEqual({
            tool: 'OpenAI API',
            status: 'gap', // gap wins — the matcher flagged it missing
            evidenceFiles: [], // honest empty: no direct evidence
            evidence: '',
            transferableBridge: 'LLM API patterns are fungible — your Bedrock/Claude work transfers',
        });
    });

    it('bridgeable gap uses a group-sibling foundation when there is no partial', () => {
        const matching = {
            verifiedMatches: [makeVerified({ skill: 'aws bedrock', evidenceFiles: ['me/repo/bedrock.ts'] })],
            partialMatches: [],
            gaps: [makeGap({ skill: 'openai api' })],
        };
        const ledger = buildSkillEvidenceLedger(['openai api'], matching, {
            techGroups: [['openai api', 'aws bedrock']],
            techAliasMap: new Map([['openai api', 'openai api'], ['aws bedrock', 'aws bedrock']]),
        });
        expect(ledger[0]!.status).toBe('gap');
        expect(ledger[0]!.evidenceFiles).toEqual([]);
        expect(ledger[0]!.transferableBridge).toMatch(/same technology group — aws bedrock is transferable/);
    });

    it('hard years-bar gap is never downgraded to transferable even with a matching partial', () => {
        const matching = {
            verifiedMatches: [],
            partialMatches: [
                makePartial({ skill: '8+ years in user operations (literal years requirement)', transferableFoundation: '~5 relevant years' }),
            ],
            gaps: [makeGap({ skill: '8+ years of relevant experience', gapType: 'hard', impactSeverity: 'significant' })],
        };
        const ledger = buildSkillEvidenceLedger(['8+ years user operations or support engineering experience'], matching);
        expect(ledger[0]!.status).toBe('gap');
    });
});
