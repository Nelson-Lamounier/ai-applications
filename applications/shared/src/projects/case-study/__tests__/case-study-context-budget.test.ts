/**
 * @format
 * Tests for packContext — the case-study context token-budget packer.
 *
 * Why this exists: the case-study agent serialises the whole CaseStudyContext
 * (commits + KB chunks + PRs) as raw JSON into one user message. With a
 * multi_repo project (2+ repos × 50 commits + 24 KB chunks, unbounded message
 * sizes) the prompt reached 213k input tokens — near Sonnet's ~200k window —
 * which then drove the model past its 16k output cap (stopReason='max_tokens')
 * and the run threw. packContext bounds the context to a global token ceiling
 * by truncating per-item text and greedily keeping the most recent / highest
 * value items, so multi_repo projects fit with output headroom to spare.
 */
import { describe, it, expect } from '@jest/globals';

import { packContext, estimateTokens } from '../case-study-context-budget.js';
import type { CaseStudyContext } from '../case-study-types.js';

function baseContext(overrides: Partial<CaseStudyContext> = {}): CaseStudyContext {
    return {
        projectId:     'p1',
        projectName:   'Test Project',
        tagline:       null,
        pitch:         null,
        userOverrides: {},
        components:    [{ id: 'c1', name: 'Backend', kind: 'backend' }],
        repositories:  [{ id: 'r1', fullName: 'o/a', primaryLanguage: 'TypeScript', topics: [], techStack: [], defaultBranch: 'main' }],
        commits:       [],
        pulls:         [],
        kbChunks:      [],
        ...overrides,
    };
}

function commit(i: number, message: string) {
    return {
        repoFullName: 'o/a',
        sha:          `sha${i}`,
        authoredAt:   `2026-05-${String((i % 28) + 1).padStart(2, '0')}T00:00:00Z`,
        authorName:   'dev',
        message,
    };
}

function kbChunk(i: number, content: string) {
    return { repoFullName: 'o/a', filePath: `f${i}.ts`, chunkType: 'document', content };
}

describe('estimateTokens', () => {
    it('approximates ~4 chars per token', () => {
        expect(estimateTokens('a'.repeat(400))).toBe(100);
    });

    it('returns 0 for empty string', () => {
        expect(estimateTokens('')).toBe(0);
    });
});

describe('packContext', () => {
    it('returns the context unchanged when already under budget', () => {
        const ctx = baseContext({
            commits:  [commit(1, 'init'), commit(2, 'add feature')],
            kbChunks: [kbChunk(1, 'short content')],
        });
        const packed = packContext(ctx, { maxTokens: 100_000 });
        expect(packed.commits).toHaveLength(2);
        expect(packed.kbChunks).toHaveLength(1);
        expect(packed.commits[0]!.message).toBe('init');
    });

    it('truncates an over-long commit message to maxCommitMessageChars', () => {
        const ctx = baseContext({ commits: [commit(1, 'x'.repeat(5_000))] });
        const packed = packContext(ctx, { maxTokens: 100_000, maxCommitMessageChars: 500 });
        expect(packed.commits[0]!.message.length).toBeLessThanOrEqual(500);
    });

    it('truncates an over-long KB chunk to maxKbChunkChars', () => {
        const ctx = baseContext({ kbChunks: [kbChunk(1, 'y'.repeat(8_000))] });
        const packed = packContext(ctx, { maxTokens: 100_000, maxKbChunkChars: 2_000 });
        expect(packed.kbChunks[0]!.content.length).toBeLessThanOrEqual(2_000);
    });

    it('drops the lowest-priority items to fit the global token ceiling', () => {
        // 100 commits, each ~250 chars (~62 tokens) → ~6200 tokens of commits.
        // A tiny ceiling must force most of them to be dropped.
        const commits = Array.from({ length: 100 }, (_, i) => commit(i, 'm'.repeat(250)));
        const ctx = baseContext({ commits });
        const packed = packContext(ctx, { maxTokens: 1_000, maxCommitMessageChars: 500 });
        // Some commits kept, but far fewer than 100, and the total fits.
        expect(packed.commits.length).toBeGreaterThan(0);
        expect(packed.commits.length).toBeLessThan(100);
        expect(estimateTokens(JSON.stringify(packed))).toBeLessThanOrEqual(1_000);
    });

    it('keeps the most-recent commits when dropping (newest-first priority)', () => {
        // commit(99) has the latest day; commit(0) the earliest.
        const commits = Array.from({ length: 100 }, (_, i) => commit(i, 'm'.repeat(250)));
        const sortedNewestFirst = [...commits].sort((a, b) => b.authoredAt.localeCompare(a.authoredAt));
        const ctx = baseContext({ commits: sortedNewestFirst });
        const packed = packContext(ctx, { maxTokens: 1_500, maxCommitMessageChars: 500 });
        // The first kept commit is the newest from the input ordering.
        expect(packed.commits[0]!.authoredAt).toBe(sortedNewestFirst[0]!.authoredAt);
    });

    it('never drops project/component/repository metadata (always preserved)', () => {
        const ctx = baseContext({
            commits:  Array.from({ length: 500 }, (_, i) => commit(i, 'm'.repeat(400))),
            kbChunks: Array.from({ length: 50 }, (_, i) => kbChunk(i, 'k'.repeat(2_000))),
        });
        const packed = packContext(ctx, { maxTokens: 2_000 });
        expect(packed.projectId).toBe('p1');
        expect(packed.components).toHaveLength(1);
        expect(packed.repositories).toHaveLength(1);
        expect(packed.repositories[0]!.fullName).toBe('o/a');
    });

    it('produces a context whose serialised size respects the ceiling', () => {
        const ctx = baseContext({
            commits:  Array.from({ length: 200 }, (_, i) => commit(i, 'm'.repeat(600))),
            kbChunks: Array.from({ length: 40 }, (_, i) => kbChunk(i, 'k'.repeat(4_000))),
            pulls:    [],
        });
        const packed = packContext(ctx, { maxTokens: 50_000 });
        expect(estimateTokens(JSON.stringify(packed))).toBeLessThanOrEqual(50_000);
    });

    it('is deterministic — same input and budget yields identical output', () => {
        const ctx = baseContext({
            commits:  Array.from({ length: 80 }, (_, i) => commit(i, 'm'.repeat(300))),
            kbChunks: Array.from({ length: 30 }, (_, i) => kbChunk(i, 'k'.repeat(1_500))),
        });
        const a = packContext(ctx, { maxTokens: 10_000 });
        const b = packContext(ctx, { maxTokens: 10_000 });
        expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    });
});

describe('packContext — evidence priority (P1 cost/sourcing fix)', () => {
    it('keeps PRs and KB chunks before commits when the budget is tight', () => {
        const bigCommits = Array.from({ length: 40 }, (_, i) => commit(i, 'c'.repeat(700)));
        const ctx = baseContext({
            commits: bigCommits,
            pulls: [{ repoFullName: 'o/r', number: 7, title: 'Add BFF', body: 'p'.repeat(600), state: 'merged', authorLogin: 'n', mergedAt: '2026-01-01', htmlUrl: 'u' }],
            kbChunks: [{ repoFullName: 'o/r', filePath: 'docs/a.md', chunkType: 'document', content: 'k'.repeat(1000) }],
        });
        // Budget only fits the skeleton + PR + chunk + a few commits.
        const packed = packContext(ctx, { maxTokens: estimateTokens(JSON.stringify({ ...ctx, commits: [], pulls: [], kbChunks: [] })) + 1200 });
        expect(packed.pulls).toHaveLength(1);       // strongest evidence survives
        expect(packed.kbChunks).toHaveLength(1);    // narrative context survives
        expect(packed.commits.length).toBeLessThan(bigCommits.length); // commits absorb the squeeze
    });

    it('pre-caps commits at maxCommits keeping the newest-first head', () => {
        const ctx = baseContext({ commits: Array.from({ length: 300 }, (_, i) => commit(i, `m${i}`)) });
        const packed = packContext(ctx, { maxTokens: 1_000_000, maxCommits: 150 });
        expect(packed.commits).toHaveLength(150);
        expect(packed.commits[0].message).toBe('m0'); // incoming (newest-first) order preserved
    });
});
