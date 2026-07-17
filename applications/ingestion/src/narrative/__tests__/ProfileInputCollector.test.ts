import { describe, it, expect, jest, afterEach } from '@jest/globals';
import { ProfileInputCollector } from '../ProfileInputCollector.js';
import { FileFetchCache } from '../../util/FileFetchCache.js';
import type { RepoCommit } from '@bedrock/shared';
import { RepoNotFoundError } from '@bedrock/shared';
import type { GitHubAdapter } from '../../acquisition/GitHubAdapter.js';

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
