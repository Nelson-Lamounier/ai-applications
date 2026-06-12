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
