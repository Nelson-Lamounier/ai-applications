import { describe, it, expect } from '@jest/globals';
import { buildChatContext } from '../context-builder.js';
import type { RetrievedPassage } from '../../retrieval/index.js';

const PROFILE_PASSAGE: RetrievedPassage = {
    text:      'Automated Kubernetes drift remediation across multi-env EKS clusters.',
    score:     0.92,
    source:    'profile',
    sourceUri: 'owner/k8s-operator',
    metadata:  { repo_full_name: 'owner/k8s-operator', chunk_type: 'highlight' },
};

const CHUNK_PASSAGE: RetrievedPassage = {
    text:      'This file implements the reconciliation loop.',
    score:     0.78,
    source:    'chunk',
    sourceUri: 'pkg/reconcile/loop.go',
    metadata:  { repo_full_name: 'owner/k8s-operator', file_path: 'pkg/reconcile/loop.go' },
};

describe('buildChatContext', () => {
    it('returns self-closing tag for empty passages', () => {
        expect(buildChatContext([])).toBe('<retrieved_context/>');
    });

    it('wraps passages in retrieved_context block', () => {
        const result = buildChatContext([PROFILE_PASSAGE]);
        expect(result).toContain('<retrieved_context>');
        expect(result).toContain('</retrieved_context>');
        expect(result).toContain('<passage');
        expect(result).toContain(PROFILE_PASSAGE.text);
    });

    it('formats profile passage with source and repo attrs', () => {
        const result = buildChatContext([PROFILE_PASSAGE]);
        expect(result).toContain('source="profile"');
        expect(result).toContain('repo="owner/k8s-operator"');
        expect(result).toContain('score="0.92"');
    });

    it('formats chunk passage with source and file attrs', () => {
        const result = buildChatContext([CHUNK_PASSAGE]);
        expect(result).toContain('source="chunk"');
        expect(result).toContain('file="pkg/reconcile/loop.go"');
    });

    it('includes all passages when multiple provided', () => {
        const result = buildChatContext([PROFILE_PASSAGE, CHUNK_PASSAGE]);
        expect(result).toContain(PROFILE_PASSAGE.text);
        expect(result).toContain(CHUNK_PASSAGE.text);
    });

    it('injects at most the top 3 passages, highest score first', () => {
        const mk = (score: number, tag: string): RetrievedPassage => ({
            text: `passage-${tag}`, score, source: 'chunk',
            sourceUri: `f/${tag}.go`,
            metadata: { repo_full_name: 'o/r', file_path: `f/${tag}.go` },
        });
        // Deliberately unordered input including a 4th, lowest-score passage.
        const result = buildChatContext([
            mk(0.71, 'c'), mk(0.93, 'a'), mk(0.55, 'd'), mk(0.82, 'b'),
        ]);
        expect(result).toContain('passage-a');
        expect(result).toContain('passage-b');
        expect(result).toContain('passage-c');
        expect(result).not.toContain('passage-d');
        // Highest score first.
        expect(result.indexOf('passage-a')).toBeLessThan(result.indexOf('passage-b'));
        expect(result.indexOf('passage-b')).toBeLessThan(result.indexOf('passage-c'));
    });

    it('truncates explicitly (no silent truncation) when char budget exceeded', () => {
        const huge: RetrievedPassage = {
            text: 'x'.repeat(20_000), score: 0.9, source: 'chunk',
            sourceUri: 'f/big.go',
            metadata: { repo_full_name: 'o/r', file_path: 'f/big.go' },
        };
        const result = buildChatContext([huge], { maxContextChars: 500 });
        expect(result).toContain('[truncated]');
        // Bounded well below the original 20k chars.
        expect(result.length).toBeLessThan(2_000);
    });

    it('respects an explicit maxChunks override', () => {
        const mk = (score: number, tag: string): RetrievedPassage => ({
            text: `p-${tag}`, score, source: 'chunk', sourceUri: `f/${tag}`,
            metadata: { repo_full_name: 'o/r', file_path: `f/${tag}` },
        });
        const result = buildChatContext(
            [mk(0.9, 'a'), mk(0.8, 'b'), mk(0.7, 'c')], { maxChunks: 1 },
        );
        expect(result).toContain('p-a');
        expect(result).not.toContain('p-b');
        expect(result).not.toContain('p-c');
    });

    it('escapes XML special characters in text and sourceUri', () => {
        const adversarial: RetrievedPassage = {
            text:      'Contains <tag> & "quotes"',
            score:     0.5,
            source:    'chunk',
            sourceUri: 'repo/<evil>/path',
            metadata:  { repo_full_name: 'owner/repo', file_path: 'repo/<evil>/path' },
        };
        const result = buildChatContext([adversarial]);
        expect(result).not.toContain('<tag>');
        expect(result).toContain('&lt;tag&gt;');
        expect(result).toContain('&amp;');
        expect(result).toContain('&quot;quotes&quot;');
        expect(result).toContain('&lt;evil&gt;');
    });
});
