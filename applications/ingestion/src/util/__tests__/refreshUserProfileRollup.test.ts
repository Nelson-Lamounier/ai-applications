import { describe, it, expect, jest } from '@jest/globals';
import { refreshUserProfileRollup } from '../refreshUserProfileRollup.js';
import type { IUserProfileRollupRepository } from '@bedrock/shared';

const rows = [{
    repoFullName: 'o/r', classification: 'project', isHidden: false,
    extractionStatus: 'completed', primaryLanguage: 'TypeScript',
    commitCount: 5, lastActiveAt: null, domain: 'infra',
    complexity: 'simple', roleInferred: 'creator', techStack: ['AWS'],
}];

describe('refreshUserProfileRollup', () => {
    it('reads, computes, and upserts on the happy path', async () => {
        const upsert = jest.fn(async () => {});
        const repo: IUserProfileRollupRepository = {
            listProfilesForRollup: jest.fn(async () => rows as never),
            upsert,
        };
        await expect(refreshUserProfileRollup(repo, 'u1')).resolves.toBeUndefined();
        expect(upsert).toHaveBeenCalledTimes(1);
        const [userId, result] = upsert.mock.calls[0] as any;
        expect(userId).toBe('u1');
        expect(result.projectRepoCount).toBe(1);
    });

    it('NEVER throws when the repository read rejects', async () => {
        const repo: IUserProfileRollupRepository = {
            listProfilesForRollup: jest.fn(async () => { throw new Error('db down'); }),
            upsert: jest.fn(async () => {}),
        };
        await expect(refreshUserProfileRollup(repo, 'u1')).resolves.toBeUndefined();
    });

    it('NEVER throws when upsert rejects', async () => {
        const repo: IUserProfileRollupRepository = {
            listProfilesForRollup: jest.fn(async () => rows as never),
            upsert: jest.fn(async () => { throw new Error('write failed'); }),
        };
        await expect(refreshUserProfileRollup(repo, 'u1')).resolves.toBeUndefined();
    });
});
