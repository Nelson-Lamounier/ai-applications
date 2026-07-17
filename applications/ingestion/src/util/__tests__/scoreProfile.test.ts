import { describe, it, expect } from '@jest/globals';
import { scoreProfile } from '../scoreProfile.js';
import type { ExtractedRepoData } from '../../narrative/ProfileExtractor.js';
import type { ProfileInputBundle } from '../../narrative/ProfileInputCollector.js';

function makeExtracted(overrides: Partial<ExtractedRepoData> = {}): ExtractedRepoData {
    return {
        project_name:  'Test Project',
        one_liner:     'A project that does useful things for developers.',
        description:   'This project helps developers do useful things efficiently.',
        domain:        'web',
        tech_stack:    ['TypeScript', 'React'],
        role_inferred: 'creator',
        complexity:    'moderate',
        highlights:    ['Built X with Y'],
        signals: {
            has_readme:       true,
            has_tests:        true,
            has_ci:           true,
            has_changelog:    true,
            has_manifest:     true,
            commit_count:     25,
            primary_language: 'TypeScript',
            last_active_at:   '2025-01-01T00:00:00Z',
        },
        confidence: 0.9,
        missing:    [],
        lifecycle:  [],
        ...overrides,
    };
}

function makeBundle(): ProfileInputBundle {
    return {
        repo_full_name:         'owner/project',
        primary_language:       'TypeScript',
        description:            'test',
        topics:                 [],
        stars:                  10,
        forks:                  1,
        is_fork:                false,
        created_at:             '2023-01-01T00:00:00Z',
        pushed_at:              new Date().toISOString(),
        commit_count:           25,
        readme:                 '# README',
        manifests:              { 'package.json': '{}' },
        changelog:              '## Changelog',
        workflows:              { 'ci.yml': 'on: push' },
        recent_commit_messages: ['feat: add feature'],
    };
}

describe('scoreProfile', () => {
    it('returns 1.0 for all signals true and confidence >= 0.7', () => {
        const { score, breakdown } = scoreProfile(makeExtracted(), makeBundle());
        expect(score).toBe(1.0);
        expect(Object.keys(breakdown)).toHaveLength(7);
    });

    it('returns 0 when all signals false', () => {
        const extracted = makeExtracted({
            signals: {
                has_readme:       false,
                has_tests:        false,
                has_ci:           false,
                has_changelog:    false,
                has_manifest:     false,
                commit_count:     5,
                primary_language: null,
                last_active_at:   null,
            },
            confidence: 0.4,
        });
        const { score } = scoreProfile(extracted, makeBundle());
        expect(score).toBe(0);
    });

    it('returns partial score for 3 signals', () => {
        const extracted = makeExtracted({
            signals: {
                has_readme:       true,  // +0.25
                has_tests:        false,
                has_ci:           false,
                has_changelog:    false,
                has_manifest:     true,  // +0.20
                commit_count:     5,     // no +0.10 (< 20)
                primary_language: 'Go',
                last_active_at:   null,
            },
            confidence: 0.8,             // +0.10
        });
        const { score } = scoreProfile(extracted, makeBundle());
        expect(score).toBeCloseTo(0.55, 5);
    });
});
