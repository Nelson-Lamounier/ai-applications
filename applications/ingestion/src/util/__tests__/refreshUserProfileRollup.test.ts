import { describe, it, expect, jest } from '@jest/globals';
import { refreshUserProfileRollup } from '../refreshUserProfileRollup.js';
import type { IUserProfileRollupRepository } from '@bedrock/shared';
import type { MirrorRevealSynthesizer } from '../../agents/MirrorRevealSynthesizer.js';

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
        const [userId, result] = upsert.mock.calls[0] as any;
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
        expect((upsert.mock.calls[0] as unknown[]).slice(2)).toEqual([]);
    });

    it('synthesizer throws → still rollup-only, never throws', async () => {
        const upsert = jest.fn(async () => {});
        const repo = { listProfilesForRollup: jest.fn(async () => rows as never), upsert, getRollup: jest.fn() } as never;
        const synth = { synthesize: jest.fn(async () => { throw new Error('x'); }) } as never;
        await expect(refreshUserProfileRollup(repo, 'u1', synth)).resolves.toBeUndefined();
        expect(upsert).toHaveBeenCalledTimes(1);
    });
});
