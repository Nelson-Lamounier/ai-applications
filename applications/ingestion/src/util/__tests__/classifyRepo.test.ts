import { describe, it, expect } from '@jest/globals';
import { classifyRepo } from '../classifyRepo.js';
import type { ProfileInputBundle } from '../../agents/ProfileInputCollector.js';

function bundle(overrides: Partial<ProfileInputBundle>): ProfileInputBundle {
    return {
        repo_full_name:         'owner/my-project',
        primary_language:       'TypeScript',
        description:            'A project',
        topics:                 [],
        stars:                  10,
        forks:                  2,
        is_fork:                false,
        created_at:             '2023-01-01T00:00:00Z',
        pushed_at:              new Date().toISOString(),
        commit_count:           50,
        readme:                 '# README',
        manifests:              { 'package.json': '{}' },
        changelog:              null,
        workflows:              {},
        recent_commit_messages: ['feat: initial commit'],
        ...overrides,
    };
}

describe('classifyRepo', () => {
    it('classifies fork with < 5 commits as fork', () => {
        expect(classifyRepo(bundle({ is_fork: true, commit_count: 3 }))).toBe('fork');
    });

    it('classifies repo with < 3 commits as abandoned', () => {
        expect(classifyRepo(bundle({ is_fork: false, commit_count: 2 }))).toBe('abandoned');
    });

    it('classifies tutorial by name pattern', () => {
        expect(classifyRepo(bundle({ repo_full_name: 'owner/react-tutorial', commit_count: 10 }))).toBe('tutorial');
        expect(classifyRepo(bundle({ repo_full_name: 'owner/hello-world', commit_count: 10 }))).toBe('tutorial');
        expect(classifyRepo(bundle({ repo_full_name: 'owner/learning-go', commit_count: 10 }))).toBe('tutorial');
    });

    it('classifies repo pushed > 5 years ago as stale', () => {
        const oldDate = new Date(Date.now() - 6 * 365 * 86400 * 1000).toISOString();
        expect(classifyRepo(bundle({ pushed_at: oldDate, commit_count: 20 }))).toBe('stale');
    });

    it('classifies sparse repo with no readme/manifest as noise', () => {
        expect(classifyRepo(bundle({
            readme:    null,
            manifests: {},
            commit_count: 5,
        }))).toBe('noise');
    });

    it('classifies normal repo as project', () => {
        expect(classifyRepo(bundle({}))).toBe('project');
    });
});
