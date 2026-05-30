import { describe, it, expect } from '@jest/globals';
import { ProfileInputCollector } from '../ProfileInputCollector.js';
import { FileFetchCache } from '../../util/FileFetchCache.js';
import type { GitHubAdapter, RepoCommit } from '@bedrock/shared';

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
            throw new Error(`${filePath} returned 404`);
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
