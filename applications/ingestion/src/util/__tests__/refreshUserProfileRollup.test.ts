import { describe, it, expect, jest } from '@jest/globals';
import { refreshUserProfileRollup } from '../refreshUserProfileRollup.js';
import type { IUserProfileRollupRepository } from '@bedrock/shared';
import type { MirrorRevealSynthesizer } from '../../agents/MirrorRevealSynthesizer.js';
import type { DirectionSynthesizer } from '../../agents/DirectionSynthesizer.js';
import type { ReconciliationSynthesizer } from '../../agents/ReconciliationSynthesizer.js';
import type { ICareerHistoryReadRepository } from '@bedrock/shared';
import type { DiagnosticNarrator } from '../../agents/DiagnosticNarrator.js';
import type { IDiagnosticInputsReadRepository, DiagnosticInputs } from '@bedrock/shared';

const inputsOk: DiagnosticInputs = {
  kbStats: { projectRepoCount: 5, reposWithHighKbScore: 3, avgRetrievalScore: 0.7 },
  resumePresent: true,
  resumeEntryCounts: { skills: 2, experience: 2, projects: 1 },
};
const inputsRepoOk = { getDiagnosticInputs: jest.fn(async () => inputsOk) } as unknown as IDiagnosticInputsReadRepository;

const careerOk = {
  getResumeForReconciliation: jest.fn(async () => ({ skills: [{ category: 'Cloud', skills: ['AWS'] }], experience: [], projects: [] })),
} as unknown as ICareerHistoryReadRepository;

const rows = [{
    repoFullName: 'o/r', classification: 'project', isHidden: false,
    extractionStatus: 'completed', primaryLanguage: 'TypeScript',
    commitCount: 5, lastActiveAt: null, domain: 'infra',
    complexity: 'simple', roleInferred: 'creator', techStack: ['AWS'],
}];

describe('refreshUserProfileRollup', () => {
    it('reads, computes, and upserts on the happy path', async () => {
        const upsert = jest.fn(async () => {});
        const repo = {
            listProfilesForRollup: jest.fn(async () => rows as never),
            upsert,
            getRollup: jest.fn(),
        } as never as IUserProfileRollupRepository;
        await expect(refreshUserProfileRollup(repo, 'u1')).resolves.toBeUndefined();
        expect(upsert).toHaveBeenCalledTimes(1);
        const [userId, result] = upsert.mock.calls[0] as unknown as [string, { projectRepoCount: number }];
        expect(userId).toBe('u1');
        expect(result.projectRepoCount).toBe(1);
    });

    it('NEVER throws when the repository read rejects', async () => {
        const repo = {
            listProfilesForRollup: jest.fn(async () => { throw new Error('db down'); }),
            upsert: jest.fn(async () => {}),
            getRollup: jest.fn(),
        } as never as IUserProfileRollupRepository;
        await expect(refreshUserProfileRollup(repo, 'u1')).resolves.toBeUndefined();
    });

    it('NEVER throws when upsert rejects', async () => {
        const repo = {
            listProfilesForRollup: jest.fn(async () => rows as never),
            upsert: jest.fn(async () => { throw new Error('write failed'); }),
            getRollup: jest.fn(),
        } as never as IUserProfileRollupRepository;
        await expect(refreshUserProfileRollup(repo, 'u1')).resolves.toBeUndefined();
    });

    it('synthesizer present → upsert carries mirror/reveal', async () => {
        const upsert = jest.fn(async () => {});
        const repo = { listProfilesForRollup: jest.fn(async () => rows as never), upsert, getRollup: jest.fn() } as never;
        const synth = { synthesize: jest.fn(async () => ({
            mirror: { paragraph: 'p'.repeat(130) },
            reveal: { reveals: [{ insight: 'i'.repeat(25), evidence: 'role distribution' }] },
        })) } as unknown as MirrorRevealSynthesizer;
        await expect(refreshUserProfileRollup(repo, 'u1', synth)).resolves.toBeUndefined();
        const call = upsert.mock.calls[0] as unknown as [string, unknown, unknown, unknown];
        expect(call[2]).toMatchObject({ paragraph: expect.any(String) });
        expect(call[3]).toMatchObject({ reveals: expect.any(Array) });
    });

    it('synthesizer absent → rollup-only upsert (no mirror/reveal args)', async () => {
        const upsert = jest.fn(async () => {});
        const repo = { listProfilesForRollup: jest.fn(async () => rows as never), upsert, getRollup: jest.fn() } as never;
        await expect(refreshUserProfileRollup(repo, 'u1')).resolves.toBeUndefined();
        const args = upsert.mock.calls[0] as unknown[];
        // The 5 synthesis args (mirror, reveal, direction, reconciliation, diagnostic) are undefined...
        expect(args.slice(2, 7).every((a) => a === undefined)).toBe(true);
        // ...but the WS4 synthesis-input hash (8th arg) is always stamped.
        expect(typeof args[7]).toBe('string');
    });

    it('WS4: skips synthesis when the rollup hash is unchanged and synthesis exists', async () => {
        let storedHash: string | null = null;
        let storedMirror: unknown = null;
        const synth = jest.fn(async () => ({
            mirror: { paragraph: 'x'.repeat(130) },
            reveal: { reveals: [{ insight: 'works across the stack', evidence: 'language share' }] },
        }));
        const synthesizer = { synthesize: synth } as never;
        const repo = {
            listProfilesForRollup: jest.fn(async () => rows as never),
            upsert: jest.fn(async (...args: unknown[]) => {
                if (args[2]) storedMirror = args[2];          // mirror (3rd arg)
                if (args[7]) storedHash = args[7] as string;  // synthesisInputHash (8th arg)
            }),
            getRollup: jest.fn(),
            getSynthesisState: jest.fn(async () =>
                storedHash ? { inputHash: storedHash, hasSynthesis: !!storedMirror } : null),
        } as never;

        await refreshUserProfileRollup(repo, 'u1', synthesizer);   // 1st: synthesise + stamp hash
        await refreshUserProfileRollup(repo, 'u1', synthesizer);   // 2nd: unchanged + synthesis exists → skip

        expect(synth).toHaveBeenCalledTimes(1);   // the LLM ran only once
    });

    it('synthesizer throws → still rollup-only, never throws', async () => {
        const upsert = jest.fn(async () => {});
        const repo = { listProfilesForRollup: jest.fn(async () => rows as never), upsert, getRollup: jest.fn() } as never;
        const synth = { synthesize: jest.fn(async () => { throw new Error('x'); }) } as never;
        await expect(refreshUserProfileRollup(repo, 'u1', synth)).resolves.toBeUndefined();
        expect(upsert).toHaveBeenCalledTimes(1);
    });

    it('directionSynth present → upsert carries direction (5th arg)', async () => {
        const upsert = jest.fn(async () => {});
        const repo = { listProfilesForRollup: jest.fn(async () => rows as never), upsert, getRollup: jest.fn() } as never;
        const dir = { synthesize: jest.fn(async () => ({ direction: { archetypes: [{ archetype: 'platform', fit: 'strong', rationale: 'domain mix' }], seniority: [], whatToDeepen: [] } })) } as unknown as DirectionSynthesizer;
        await expect(refreshUserProfileRollup(repo, 'u1', undefined, dir)).resolves.toBeUndefined();
        const call = upsert.mock.calls[0] as unknown as unknown[];
        expect(call[4]).toMatchObject({ archetypes: expect.any(Array) });
    });

    it('directionSynth absent → upsert direction arg undefined; mirror path unaffected', async () => {
        const upsert = jest.fn(async () => {});
        const repo = { listProfilesForRollup: jest.fn(async () => rows as never), upsert, getRollup: jest.fn() } as never;
        await expect(refreshUserProfileRollup(repo, 'u1')).resolves.toBeUndefined();
        expect((upsert.mock.calls[0] as unknown[])[4]).toBeUndefined();
    });

    it('directionSynth throws → still resolves, mirror/reveal independent, ingestion never fails', async () => {
        const upsert = jest.fn(async () => {});
        const repo = { listProfilesForRollup: jest.fn(async () => rows as never), upsert, getRollup: jest.fn() } as never;
        const dir = { synthesize: jest.fn(async () => { throw new Error('x'); }) } as never;
        await expect(refreshUserProfileRollup(repo, 'u1', undefined, dir)).resolves.toBeUndefined();
        expect(upsert).toHaveBeenCalledTimes(1);
    });

    it('reconciliationSynth + careerRepo present → upsert carries reconciliation (6th arg)', async () => {
        const upsert = jest.fn(async () => {});
        const repo = { listProfilesForRollup: jest.fn(async () => rows as never), upsert, getRollup: jest.fn() } as never;
        const rec = { synthesize: jest.fn(async () => ({ reconciliation: { unsupportedClaims: [{ claim:'a claim text', resumeRef:'Acme', whyUnsupported:'why text here' }], undersold: [] } })) } as unknown as ReconciliationSynthesizer;
        await expect(refreshUserProfileRollup(repo, 'u1', undefined, undefined, rec, careerOk)).resolves.toBeUndefined();
        const call = upsert.mock.calls[0] as unknown as unknown[];
        expect(call[5]).toMatchObject({ unsupportedClaims: expect.any(Array) });
    });

    it('reconciliationSynth absent → upsert reconciliation arg undefined; other paths unaffected', async () => {
        const upsert = jest.fn(async () => {});
        const repo = { listProfilesForRollup: jest.fn(async () => rows as never), upsert, getRollup: jest.fn() } as never;
        await expect(refreshUserProfileRollup(repo, 'u1')).resolves.toBeUndefined();
        expect((upsert.mock.calls[0] as unknown[])[5]).toBeUndefined();
    });

    it('career read throws → still resolves, reconciliation skipped, ingestion never fails', async () => {
        const upsert = jest.fn(async () => {});
        const repo = { listProfilesForRollup: jest.fn(async () => rows as never), upsert, getRollup: jest.fn() } as never;
        const rec = { synthesize: jest.fn(async () => ({ reconciliation: { unsupportedClaims: [], undersold: [] } })) } as never;
        const careerThrows = { getResumeForReconciliation: jest.fn(async () => { throw new Error('db'); }) } as never;
        await expect(refreshUserProfileRollup(repo, 'u1', undefined, undefined, rec, careerThrows)).resolves.toBeUndefined();
        expect((upsert.mock.calls[0] as unknown[])[5]).toBeUndefined();
        expect(upsert).toHaveBeenCalledTimes(1);
    });

    it('reconciliationSynth throws → upsert proceeds, mirror/reveal/direction unaffected', async () => {
        const upsert = jest.fn(async () => {});
        const repo = { listProfilesForRollup: jest.fn(async () => rows as never), upsert, getRollup: jest.fn() } as never;
        const synth = { synthesize: jest.fn(async () => ({
            mirror: { paragraph: 'p'.repeat(130) },
            reveal: { reveals: [{ insight: 'i'.repeat(25), evidence: 'role distribution' }] },
        })) } as unknown as MirrorRevealSynthesizer;
        const dir = { synthesize: jest.fn(async () => ({ direction: { archetypes: [{ archetype: 'platform', fit: 'strong', rationale: 'domain mix' }], seniority: [], whatToDeepen: [] } })) } as unknown as DirectionSynthesizer;
        const rec = { synthesize: jest.fn(async () => { throw new Error('x'); }) } as never;
        await expect(refreshUserProfileRollup(repo, 'u1', synth, dir, rec, careerOk)).resolves.toBeUndefined();
        const call = upsert.mock.calls[0] as unknown[];
        expect(call[2]).toMatchObject({ paragraph: expect.any(String) });
        expect(call[3]).toMatchObject({ reveals: expect.any(Array) });
        expect(call[4]).toMatchObject({ archetypes: expect.any(Array) });
        expect(call[5]).toBeUndefined();
        expect(upsert).toHaveBeenCalledTimes(1);
    });

    it('reconciliationSynth present but careerRepo absent → reconciliation skipped, upsert once', async () => {
        const upsert = jest.fn(async () => {});
        const repo = { listProfilesForRollup: jest.fn(async () => rows as never), upsert, getRollup: jest.fn() } as never;
        const rec = { synthesize: jest.fn(async () => ({ reconciliation: { unsupportedClaims: [], undersold: [] } })) } as unknown as ReconciliationSynthesizer;
        await expect(refreshUserProfileRollup(repo, 'u1', undefined, undefined, rec)).resolves.toBeUndefined();
        expect((upsert.mock.calls[0] as unknown[])[5]).toBeUndefined();
        expect(rec.synthesize).not.toHaveBeenCalled();
        expect(upsert).toHaveBeenCalledTimes(1);
    });

    it('diagnosticInputsRepo present → upsert carries diagnostic (7th arg) with deterministic fields', async () => {
        const upsert = jest.fn(async () => {});
        const repo = { listProfilesForRollup: jest.fn(async () => rows as never), upsert, getRollup: jest.fn() } as never;
        await expect(refreshUserProfileRollup(repo, 'u1', undefined, undefined, undefined, undefined, undefined, inputsRepoOk)).resolves.toBeUndefined();
        const call = upsert.mock.calls[0] as unknown as unknown[];
        expect(call[6]).toMatchObject({ overall: expect.any(Number), components: expect.any(Object), explanation: null });
    });

    it('diagnosticInputsRepo absent → upsert diagnostic arg undefined (no computation)', async () => {
        const upsert = jest.fn(async () => {});
        const repo = { listProfilesForRollup: jest.fn(async () => rows as never), upsert, getRollup: jest.fn() } as never;
        await expect(refreshUserProfileRollup(repo, 'u1')).resolves.toBeUndefined();
        expect((upsert.mock.calls[0] as unknown[])[6]).toBeUndefined();
    });

    it('inputs read THROWS → upsert diagnostic arg undefined (COALESCE-preserve prior)', async () => {
        const upsert = jest.fn(async () => {});
        const repo = { listProfilesForRollup: jest.fn(async () => rows as never), upsert, getRollup: jest.fn() } as never;
        const inputsRepoThrows = { getDiagnosticInputs: jest.fn(async () => { throw new Error('db'); }) } as never;
        await expect(refreshUserProfileRollup(repo, 'u1', undefined, undefined, undefined, undefined, undefined, inputsRepoThrows)).resolves.toBeUndefined();
        expect((upsert.mock.calls[0] as unknown[])[6]).toBeUndefined();
        expect(upsert).toHaveBeenCalledTimes(1);
    });

    it('narrator throws → diagnostic still persisted with explanation:null', async () => {
        const upsert = jest.fn(async () => {});
        const repo = { listProfilesForRollup: jest.fn(async () => rows as never), upsert, getRollup: jest.fn() } as never;
        const narrator = { narrate: jest.fn(async () => { throw new Error('bedrock'); }) } as unknown as DiagnosticNarrator;
        await expect(refreshUserProfileRollup(repo, 'u1', undefined, undefined, undefined, undefined, narrator, inputsRepoOk)).resolves.toBeUndefined();
        const call = upsert.mock.calls[0] as unknown as unknown[];
        expect(call[6]).toMatchObject({ overall: expect.any(Number), explanation: null });
    });

    it('narrator returns string → diagnostic carries explanation', async () => {
        const upsert = jest.fn(async () => {});
        const repo = { listProfilesForRollup: jest.fn(async () => rows as never), upsert, getRollup: jest.fn() } as never;
        const narrator = { narrate: jest.fn(async () => 'A narrative explanation that is more than forty characters long for the schema.') } as unknown as DiagnosticNarrator;
        await expect(refreshUserProfileRollup(repo, 'u1', undefined, undefined, undefined, undefined, narrator, inputsRepoOk)).resolves.toBeUndefined();
        const call = upsert.mock.calls[0] as unknown as unknown[];
        expect((call[6] as { explanation: string | null }).explanation).toContain('narrative');
    });

    it('diagnostic isolation: an inputs failure does not affect mirror/reveal/direction/reconciliation positions', async () => {
        const upsert = jest.fn(async () => {});
        const repo = { listProfilesForRollup: jest.fn(async () => rows as never), upsert, getRollup: jest.fn() } as never;
        const synth = { synthesize: jest.fn(async () => ({ mirror: { paragraph: 'm' }, reveal: { reveals: [] } })) } as never;
        const dir = { synthesize: jest.fn(async () => ({ direction: { archetypes: [{ archetype:'platform', fit:'strong', rationale:'domain mix' }], seniority: [], whatToDeepen: [] } })) } as never;
        const inputsRepoThrows = { getDiagnosticInputs: jest.fn(async () => { throw new Error('db'); }) } as never;
        await expect(refreshUserProfileRollup(repo, 'u1', synth, dir, undefined, undefined, undefined, inputsRepoThrows)).resolves.toBeUndefined();
        const call = upsert.mock.calls[0] as unknown[];
        expect(call[2]).toMatchObject({ paragraph: 'm' });
        expect(call[4]).toMatchObject({ archetypes: expect.any(Array) });
        expect(call[6]).toBeUndefined();
    });
});

describe('refreshUserProfileRollup upsert retry (loud persistence)', () => {
    it('retries the upsert ONCE on a transient failure and persists on the second attempt', async () => {
        const upsert = jest.fn(async () => {})
            .mockImplementationOnce(async () => { throw new Error('transient pool error'); });
        const repo = {
            listProfilesForRollup: jest.fn(async () => rows as never),
            upsert,
            getRollup: jest.fn(),
        } as never as IUserProfileRollupRepository;

        await expect(refreshUserProfileRollup(repo, 'u1')).resolves.toBeUndefined();
        expect(upsert).toHaveBeenCalledTimes(2);
    });

    it('gives up after the retry, never throws, and stops at two attempts', async () => {
        const upsert = jest.fn(async () => { throw new Error('write failed'); });
        const repo = {
            listProfilesForRollup: jest.fn(async () => rows as never),
            upsert,
            getRollup: jest.fn(),
        } as never as IUserProfileRollupRepository;

        await expect(refreshUserProfileRollup(repo, 'u1')).resolves.toBeUndefined();
        expect(upsert).toHaveBeenCalledTimes(2);
    });
});
