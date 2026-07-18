/**
 * @format
 * MarkdownChunker Unit Tests
 *
 * Pure logic — no mocks, no async, no AWS calls.
 * Run against actual markdown patterns from the portfolio repo.
 */

import { MarkdownChunker } from '../MarkdownChunker';

describe('MarkdownChunker', () => {
    const chunker = new MarkdownChunker();

    // =========================================================================
    // canHandle
    // =========================================================================
    describe('canHandle()', () => {
        it('accepts .md files', () => {
            expect(chunker.canHandle('README.md')).toBe(true);
            expect(chunker.canHandle('docs/overview.md')).toBe(true);
        });

        it('accepts .mdx files', () => {
            expect(chunker.canHandle('pages/index.mdx')).toBe(true);
        });

        it('rejects non-markdown files', () => {
            expect(chunker.canHandle('src/index.ts')).toBe(false);
            expect(chunker.canHandle('config.yaml')).toBe(false);
            expect(chunker.canHandle('Makefile')).toBe(false);
        });
    });

    // =========================================================================
    // chunk — basic heading splitting
    // =========================================================================
    describe('chunk() — heading splitting', () => {
        const md = `
# Introduction

This is the introduction section.
It has two sentences.

## Background

This is the background section.

## Motivation

Why we built this thing.
`.trim();

        it('produces one chunk per heading', () => {
            const chunks = chunker.chunk(md, 'README.md');
            expect(chunks.length).toBe(3);
        });

        it('includes heading text in chunk content', () => {
            const chunks = chunker.chunk(md, 'README.md');
            expect(chunks[0].content).toContain('# Introduction');
            expect(chunks[1].content).toContain('## Background');
            expect(chunks[2].content).toContain('## Motivation');
        });

        it('sets heading field correctly', () => {
            const chunks = chunker.chunk(md, 'README.md');
            expect(chunks[0].heading).toBe('# Introduction');
            expect(chunks[1].heading).toBe('## Background');
            expect(chunks[2].heading).toBe('## Motivation');
        });

        it('assigns sequential chunkIndex', () => {
            const chunks = chunker.chunk(md, 'README.md');
            expect(chunks.map(c => c.chunkIndex)).toEqual([0, 1, 2]);
        });

        it('sets totalChunks correctly', () => {
            const chunks = chunker.chunk(md, 'README.md');
            chunks.forEach(c => expect(c.totalChunks).toBe(3));
        });

        it('sets filePath on every chunk', () => {
            const chunks = chunker.chunk(md, 'docs/arch.md');
            chunks.forEach(c => expect(c.filePath).toBe('docs/arch.md'));
        });

        it('sets fileType to md', () => {
            const chunks = chunker.chunk(md, 'docs/arch.md');
            chunks.forEach(c => expect(c.fileType).toBe('md'));
        });
    });

    // =========================================================================
    // chunk — preamble (content before first heading)
    // =========================================================================
    describe('chunk() — preamble handling', () => {
        const md = `This is a preamble paragraph before any heading.
It has multiple sentences and is substantive enough to embed.

# First Section

Content of first section.
`.trim();

        it('includes preamble as a chunk when it meets minChunkChars', () => {
            const chunks = chunker.chunk(md, 'README.md');
            // Preamble + First Section = 2 chunks
            expect(chunks.length).toBe(2);
        });

        it('preamble chunk has no heading', () => {
            const chunks = chunker.chunk(md, 'README.md');
            expect(chunks[0].heading).toBeUndefined();
        });
    });

    // =========================================================================
    // chunk — frontmatter stripping
    // =========================================================================
    describe('chunk() — frontmatter', () => {
        const md = `---
title: Architecture Overview
date: 2024-01-01
tags: [aws, cdk]
---

# Architecture

Main content here with enough words to be meaningful for vector search.
`.trim();

        it('strips YAML frontmatter and does not emit it as a chunk', () => {
            const chunks = chunker.chunk(md, 'docs/arch.md');
            chunks.forEach(c => {
                expect(c.content).not.toContain('title:');
                expect(c.content).not.toContain('date:');
            });
        });

        it('still produces chunks from content after frontmatter', () => {
            const chunks = chunker.chunk(md, 'docs/arch.md');
            expect(chunks.length).toBeGreaterThan(0);
            expect(chunks[0].content).toContain('# Architecture');
        });
    });

    // =========================================================================
    // chunk — empty sections discarded
    // =========================================================================
    describe('chunk() — empty section filtering', () => {
        const md = `# Section A

Substantial content in section A that is long enough to embed.

# Section B

# Section C

More content in section C that passes the minimum character threshold.
`.trim();

        it('discards heading-only sections below minChunkChars', () => {
            const chunks = chunker.chunk(md, 'README.md');
            // Section B has no body — should be discarded
            const headings = chunks.map(c => c.heading);
            expect(headings).not.toContain('# Section B');
        });

        it('retains sections with sufficient content', () => {
            const chunks = chunker.chunk(md, 'README.md');
            const headings = chunks.map(c => c.heading);
            expect(headings).toContain('# Section A');
            expect(headings).toContain('# Section C');
        });
    });

    // =========================================================================
    // chunk — large section split at paragraph boundaries
    // =========================================================================
    describe('chunk() — paragraph overflow splitting', () => {
        const longParagraph = 'word '.repeat(200);  // ~1000 chars per paragraph

        const md = [
            '# Large Section',
            '',
            longParagraph.trim(),
            '',
            longParagraph.trim(),
            '',
            longParagraph.trim(),
        ].join('\n');

        it('splits large sections into multiple chunks', () => {
            const smallChunker = new MarkdownChunker({ maxChunkChars: 1200 });
            const chunks = smallChunker.chunk(md, 'large.md');
            expect(chunks.length).toBeGreaterThan(1);
        });

        it('each sub-chunk carries the heading', () => {
            const smallChunker = new MarkdownChunker({ maxChunkChars: 1200 });
            const chunks = smallChunker.chunk(md, 'large.md');
            expect(chunks[0].heading).toBe('# Large Section');
        });

        it('sub-chunks respect totalChunks', () => {
            const smallChunker = new MarkdownChunker({ maxChunkChars: 1200 });
            const chunks = smallChunker.chunk(md, 'large.md');
            chunks.forEach(c => expect(c.totalChunks).toBe(chunks.length));
        });
    });

    // =========================================================================
    // chunk — tags derived from file path
    // =========================================================================
    describe('chunk() — tags from path', () => {
        it('derives tags from directory segments', () => {
            const md = '# Title\n\nSome content that is definitely long enough to embed properly.';
            const chunks = chunker.chunk(md, 'docs/architecture/overview.md');
            expect(chunks[0].tags).toEqual(['docs', 'architecture']);
        });

        it('has no tags for root-level files', () => {
            const md = '# Title\n\nSome content that is definitely long enough to embed properly.';
            const chunks = chunker.chunk(md, 'README.md');
            expect(chunks[0].tags).toEqual([]);
        });
    });

    // =========================================================================
    // chunk — MDX file type
    // =========================================================================
    describe('chunk() — MDX', () => {
        it('sets fileType to mdx for .mdx files', () => {
            const md = '# Title\n\nContent that passes the minimum character threshold for embedding.';
            const chunks = chunker.chunk(md, 'pages/index.mdx');
            expect(chunks[0].fileType).toBe('mdx');
        });
    });

    // =========================================================================
    // chunk — single-chunk file
    // =========================================================================
    describe('chunk() — file with no headings', () => {
        const md = `This markdown file has no headings at all.
It is just a block of prose that should be returned as a single chunk.
The content is long enough to pass the minimum character threshold for embedding.
`;

        it('returns a single chunk for headingless content', () => {
            const chunks = chunker.chunk(md, 'CONTRIBUTING.md');
            expect(chunks.length).toBe(1);
            expect(chunks[0].chunkIndex).toBe(0);
            expect(chunks[0].totalChunks).toBe(1);
        });
    });

    // =========================================================================
    // chunk — frontmatter parsing (tags merge + metadata flow)
    // =========================================================================
    describe('chunk() — frontmatter parsing', () => {
        it('merges frontmatter tags with directory tags, lowercased + deduped', () => {
            const md = `---
title: Traefik
tags: [Kubernetes, ingress, NETWORKING]
---

# Traefik

Body content with enough length to pass the minimum embed threshold.
`.trim();
            const chunks = chunker.chunk(md, 'wiki/Tools/traefik.md');
            // Directory: ['wiki','Tools'] → lowercased → ['wiki','tools']
            // Frontmatter: ['Kubernetes','ingress','NETWORKING'] → ['kubernetes','ingress','networking']
            // Set semantics + lowercase guarantees no duplicates.
            expect(chunks[0].tags).toEqual(
                expect.arrayContaining(['wiki', 'tools', 'kubernetes', 'ingress', 'networking']),
            );
            expect(chunks[0].tags?.length).toBe(5);
        });

        it('flows non-tag frontmatter keys into chunk metadata', () => {
            const md = `---
title: Architecture Overview
type: concept
sources: ['raw/foo.md', 'raw/bar.md']
created: 2026-04-15
---

# Architecture

Body content that is long enough to be embedded as a chunk.
`.trim();
            const chunks = chunker.chunk(md, 'docs/arch.md');
            const meta = chunks[0].metadata as Record<string, unknown>;
            expect(meta.title).toBe('Architecture Overview');
            expect(meta.type).toBe('concept');
            expect(meta.sources).toEqual(['raw/foo.md', 'raw/bar.md']);
            expect(meta.created).toBe('2026-04-15');
            // tags should not appear in metadata — they live on the chunk's tags field
            expect(meta.tags).toBeUndefined();
        });

        it('emits empty metadata object when no frontmatter is present', () => {
            const md = '# Title\n\nBody content long enough to embed properly.';
            const chunks = chunker.chunk(md, 'docs/x.md');
            expect(chunks[0].metadata).toEqual({});
        });

        it('does not emit frontmatter scalar values inside chunk content', () => {
            const md = `---
title: Hidden
type: concept
---

# Visible

Body content long enough for embedding.
`.trim();
            const chunks = chunker.chunk(md, 'docs/x.md');
            chunks.forEach(c => {
                expect(c.content).not.toContain('title:');
                expect(c.content).not.toContain('Hidden');
            });
        });
    });

    // =========================================================================
    // chunk — wikilink stripping (preserves noun, drops syntax)
    // =========================================================================
    describe('chunk() — wikilink stripping', () => {
        it('replaces [[page]] with page', () => {
            const md = '# T\n\nSee [[admin-api]] for details. Plenty of content here.';
            const chunks = chunker.chunk(md, 'docs/x.md');
            expect(chunks[0].content).toContain('See admin-api for details');
            expect(chunks[0].content).not.toContain('[[');
        });

        it('replaces [[folder/page]] with page', () => {
            const md = '# T\n\nLink to [[projects/admin-api]] is critical context here.';
            const chunks = chunker.chunk(md, 'docs/x.md');
            expect(chunks[0].content).toContain('Link to admin-api');
            expect(chunks[0].content).not.toContain('projects/');
        });

        it('replaces [[page|alias]] with alias', () => {
            const md = '# T\n\nThe [[admin-api|BFF service]] handles the request lifecycle.';
            const chunks = chunker.chunk(md, 'docs/x.md');
            expect(chunks[0].content).toContain('The BFF service handles');
            expect(chunks[0].content).not.toContain('admin-api');
            expect(chunks[0].content).not.toContain('|');
        });

        it('replaces [[folder/page|alias]] with alias', () => {
            const md = '# T\n\nThe [[projects/admin-api|BFF]] is the gateway. More body content.';
            const chunks = chunker.chunk(md, 'docs/x.md');
            expect(chunks[0].content).toContain('The BFF is the gateway');
            expect(chunks[0].content).not.toContain('projects/');
            expect(chunks[0].content).not.toContain('admin-api');
        });
    });
});
