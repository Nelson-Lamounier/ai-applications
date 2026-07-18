import { describe, it, expect, jest, afterEach } from '@jest/globals';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProfileInputCollector } from '../ProfileInputCollector.js';
import { FileFetchCache } from '../../util/FileFetchCache.js';
import type { RepoCommit } from '@bedrock/shared';
import { RepoNotFoundError } from '@bedrock/shared';
import type { GitHubAdapter } from '../../acquisition/GitHubAdapter.js';
import type { IRepoAdapter } from '../../acquisition/IRepoAdapter.js';
import { TarballRepoAdapter } from '../../acquisition/TarballRepoAdapter.js';

// ---------------------------------------------------------------------------
// Stub helpers
// ---------------------------------------------------------------------------

function makeAdapter(overrides: {
    readme?: string;
    commits?: string[];
} = {}): GitHubAdapter {
    const readme = overrides.readme ?? '# Test Repo';
    const commits = overrides.commits ?? ['initial commit'];

    return {
        getRepoMeta: async (_repo: string) => ({
            primary_language: 'TypeScript',
            description:      'A test repo',
            topics:           [],
            stars:            0,
            forks:            0,
            is_fork:          false,
            created_at:       '2024-01-01T00:00:00Z',
            pushed_at:        '2024-06-01T00:00:00Z',
        }),
        listCommits: async (_repo: string) =>
            commits.map((message, i): RepoCommit => ({
                sha:        `sha${i}`,
                authorName: 'Test Author',
                authoredAt: '2024-06-01T00:00:00Z',
                message,
            })),
        fetchFile: async (_repo: string, filePath: string): Promise<string> => {
            if (filePath === 'README.md') return readme;
            // Reproduce production: the real GitHubAdapter raises RepoNotFoundError
            // (NOT a generic "returned 404" Error) for an absent file. The
            // collector must treat this as "absent" and stay silent.
            throw new RepoNotFoundError(`/repos/owner/repo/contents/${filePath}`);
        },
        listFiles: async (_repo: string) => [],
    } as unknown as GitHubAdapter;
}

function makeCollectorWithStub(overrides: {
    readme?: string;
    commits?: string[];
}): ProfileInputCollector {
    const adapter = makeAdapter(overrides);
    const cache   = new FileFetchCache();
    return new ProfileInputCollector(adapter, cache);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ProfileInputCollector absent-file handling', () => {
    afterEach(() => { jest.restoreAllMocks(); });

    it('treats absent optional files (RepoNotFoundError) as empty without warning', async () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        // Only README.md exists; every probed manifest/changelog raises
        // RepoNotFoundError. The bundle should still build, with empty manifests.
        const collector = makeCollectorWithStub({ readme: '# Repo' });
        const bundle = await collector.collect('owner/repo');

        expect(bundle.manifests).toEqual({});
        expect(bundle.changelog ?? null).toBeNull();
        // The crux: absent files must NOT be logged as warnings.
        expect(warn).not.toHaveBeenCalled();
    });
});

describe('ProfileInputCollector PII scrubbing', () => {
    it('redacts PII from README and commit messages in the collected bundle', async () => {
        const collector = makeCollectorWithStub({
            readme:  'Maintainer: jane@corp.com — see notes',
            commits: ['fix by john@corp.com', 'normal commit'],
        });
        const bundle = await collector.collect('owner/repo');
        const serialized = JSON.stringify(bundle);
        expect(serialized).not.toContain('jane@corp.com');
        expect(serialized).not.toContain('john@corp.com');
        expect(bundle.readme ?? '').toContain('[EMAIL]');
    });
});

// ---------------------------------------------------------------------------
// IRepoAdapter widening (P2 Task 4, Fix B) — one-download unified acquisition
// ---------------------------------------------------------------------------

describe('ProfileInputCollector against a TarballRepoAdapter (unified acquisition)', () => {
    const dirs: string[] = [];
    afterEach(async () => {
        await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
    });

    it('serves fetchFile from disk (no delegate.fetchFile calls) while getRepoMeta/listCommits delegate', async () => {
        const extractDir = await fs.mkdtemp(path.join(os.tmpdir(), 'profile-collector-tarball-'));
        dirs.push(extractDir);
        await fs.writeFile(path.join(extractDir, 'README.md'), '# From disk');

        const delegateFetchFile = jest.fn<() => Promise<string>>();
        const delegateGetRepoMeta = jest.fn(async () => ({
            primary_language: 'TypeScript',
            description:      'A tarball-backed repo',
            topics:            [] as string[],
            stars:             0,
            forks:             0,
            is_fork:           false,
            created_at:        '2024-01-01T00:00:00Z',
            pushed_at:         '2024-06-01T00:00:00Z',
        }));
        const delegateListCommits = jest.fn(async (): Promise<RepoCommit[]> => [
            { sha: 'sha0', authorName: 'Test Author', authoredAt: '2024-06-01T00:00:00Z', message: 'initial commit' },
        ]);

        const delegate = {
            getRepoMeta:  delegateGetRepoMeta,
            listCommits:  delegateListCommits,
            fetchFile:    delegateFetchFile,
            listFiles:    async () => [],
        } as unknown as IRepoAdapter;

        const adapter = new TarballRepoAdapter(extractDir, 'resolved-sha', delegate);
        const cache = new FileFetchCache();
        const collector = new ProfileInputCollector(adapter, cache);

        const bundle = await collector.collect('owner/repo');

        expect(bundle.readme).toBe('# From disk');
        expect(delegateFetchFile).not.toHaveBeenCalled();
        expect(delegateGetRepoMeta).toHaveBeenCalledTimes(1);
        expect(delegateGetRepoMeta).toHaveBeenCalledWith('owner/repo');
        expect(delegateListCommits).toHaveBeenCalledTimes(1);
    });

    it('treats a missing probe file on the tarball adapter as absent, silently (no console.warn)', async () => {
        // Real disk-backed adapter (not a stub): only README.md exists, so
        // every manifest/changelog probe hits fs ENOENT -> RepoNotFoundError
        // (see TarballRepoAdapter.fetchFile). This must classify identically
        // to the GitHub 404 path in ProfileInputCollector.fetchFile.
        const extractDir = await fs.mkdtemp(path.join(os.tmpdir(), 'profile-collector-tarball-missing-'));
        dirs.push(extractDir);
        await fs.writeFile(path.join(extractDir, 'README.md'), '# Only a README');

        const delegate = {
            getRepoMeta: async () => ({
                primary_language: 'TypeScript',
                description:      'A tarball-backed repo',
                topics:            [] as string[],
                stars:             0,
                forks:             0,
                is_fork:           false,
                created_at:        '2024-01-01T00:00:00Z',
                pushed_at:         '2024-06-01T00:00:00Z',
            }),
            listCommits: async (): Promise<RepoCommit[]> => [],
            fetchFile:   async () => { throw new Error('delegate.fetchFile should not be called'); },
            listFiles:   async () => [],
        } as unknown as IRepoAdapter;

        const adapter = new TarballRepoAdapter(extractDir, 'resolved-sha', delegate);
        const collector = new ProfileInputCollector(adapter, new FileFetchCache());

        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const bundle = await collector.collect('owner/repo');

        expect(bundle.readme).toBe('# Only a README');
        expect(bundle.manifests).toEqual({});
        expect(bundle.changelog ?? null).toBeNull();
        expect(warn).not.toHaveBeenCalled();
    });

    it('throws a clear error when the adapter has no getRepoMeta (e.g. a bare stub adapter)', async () => {
        const adapterWithoutRepoMeta = {
            listCommits: async () => [],
            fetchFile:   async () => { throw new RepoNotFoundError('/x'); },
            listFiles:   async () => [],
        } as unknown as IRepoAdapter;

        const collector = new ProfileInputCollector(adapterWithoutRepoMeta, new FileFetchCache());

        await expect(collector.collect('owner/repo')).rejects.toThrow(/getRepoMeta/);
    });
});
