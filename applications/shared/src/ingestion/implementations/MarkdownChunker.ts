/**
 * @format
 * MarkdownChunker — IChunker for Markdown and MDX files
 *
 * Pure class — no I/O, no async, no external dependencies.
 * Splits markdown into semantically coherent chunks based on heading structure.
 *
 * Chunking strategy:
 *   1. Strip YAML frontmatter (--- ... ---) — not useful for vector search
 *   2. Split content on heading lines (# ## ### ####)
 *   3. Each heading + its body becomes a candidate chunk
 *   4. Chunks exceeding maxChunkChars are split at paragraph boundaries
 *   5. Empty chunks (heading only, no body) are discarded
 *   6. Preamble (content before first heading) is kept if non-empty
 *
 * Heading in chunk content:
 *   The heading line is included at the top of each chunk's content.
 *   This ensures the embedding captures the semantic context of the heading
 *   even when chunks are retrieved without surrounding context.
 *
 * Tags:
 *   Derived from the file path (e.g. 'docs/architecture/overview.md' →
 *   ['docs', 'architecture']). The file extension is excluded.
 */

import type { RawChunk } from '../../aurora/types.js';
import type { IChunker } from '../interfaces/IChunker.js';

// =============================================================================
// INTERNAL TYPES
// =============================================================================

interface Section {
    heading: string | undefined;
    headingLevel: number;       // 0 = preamble, 1–4 = H1–H4
    content: string;
}

// =============================================================================
// CONFIG
// =============================================================================

export interface MarkdownChunkerConfig {
    /**
     * Maximum characters per chunk.
     * Chunks exceeding this are split at paragraph boundaries (blank lines).
     * Titan Embed v2 max input: 8192 tokens ≈ 32768 chars.
     * Recommended: 1500–2500 chars for good recall/precision balance.
     * Default: 2000
     */
    readonly maxChunkChars: number;

    /**
     * Minimum characters for a chunk to be emitted.
     * Prevents truly empty or whitespace-only stubs.
     * Keep this low — short sections (e.g. "## Background\n\nSee also: X.")
     * are still semantically meaningful for retrieval.
     * Default: 30
     */
    readonly minChunkChars: number;
}

const DEFAULT_CONFIG: MarkdownChunkerConfig = {
    maxChunkChars: 2000,
    minChunkChars: 30,
};

// =============================================================================
// IMPLEMENTATION
// =============================================================================

export class MarkdownChunker implements IChunker {
    private readonly config: MarkdownChunkerConfig;

    constructor(config: Partial<MarkdownChunkerConfig> = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    // =========================================================================
    // IChunker
    // =========================================================================

    canHandle(filePath: string): boolean {
        return filePath.endsWith('.md') || filePath.endsWith('.mdx');
    }

    chunk(content: string, filePath: string): RawChunk[] {
        const tags     = this.tagsFromPath(filePath);
        const fileType = filePath.endsWith('.mdx') ? 'mdx' : 'md';

        const stripped  = this.stripFrontmatter(content);
        const sections  = this.splitIntoSections(stripped);
        const chunks    = this.sectionsToChunks(sections, filePath, tags, fileType);

        // Assign final chunkIndex / totalChunks after all splits are known
        return chunks.map((c, i) => ({ ...c, chunkIndex: i, totalChunks: chunks.length }));
    }

    // =========================================================================
    // Frontmatter
    // =========================================================================

    private stripFrontmatter(content: string): string {
        // YAML frontmatter: starts at line 0 with ---, ends with ---
        const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
        return match ? content.slice(match[0].length) : content;
    }

    // =========================================================================
    // Section splitting
    // =========================================================================

    /**
     * Split content on heading lines.
     * Returns sections in document order with their heading and body text.
     */
    private splitIntoSections(content: string): Section[] {
        const lines    = content.split('\n');
        const sections: Section[] = [];
        let currentHeading: string | undefined;
        let currentLevel  = 0;
        let bodyLines: string[] = [];

        const flush = () => {
            const body = bodyLines.join('\n').trim();
            if (body || currentHeading) {
                sections.push({
                    heading:      currentHeading,
                    headingLevel: currentLevel,
                    content:      body,
                });
            }
            bodyLines = [];
        };

        for (const line of lines) {
            const headingMatch = line.match(/^(#{1,4})\s+(.+)/);
            if (headingMatch) {
                flush();
                currentLevel   = headingMatch[1].length;
                currentHeading = line.trim();
            } else {
                bodyLines.push(line);
            }
        }
        flush();

        return sections;
    }

    // =========================================================================
    // Chunk assembly
    // =========================================================================

    /**
     * Convert sections into RawChunks.
     * Sections exceeding maxChunkChars are split at paragraph boundaries.
     * Sections below minChunkChars are discarded.
     */
    private sectionsToChunks(
        sections: Section[],
        filePath: string,
        tags: string[],
        fileType: string,
    ): Omit<RawChunk, 'chunkIndex' | 'totalChunks'>[] {
        const chunks: Omit<RawChunk, 'chunkIndex' | 'totalChunks'>[] = [];

        for (const section of sections) {
            // Full content = heading line (if any) + body
            const fullContent = section.heading
                ? `${section.heading}\n\n${section.content}`
                : section.content;

            if (fullContent.trim().length < this.config.minChunkChars) continue;

            if (fullContent.length <= this.config.maxChunkChars) {
                chunks.push({
                    filePath,
                    heading:  section.heading,
                    content:  fullContent.trim(),
                    fileType,
                    tags,
                });
            } else {
                // Split at paragraph boundaries and carry heading into each sub-chunk
                const subChunks = this.splitAtParagraphs(
                    section.content,
                    section.heading,
                    filePath,
                    tags,
                    fileType,
                );
                chunks.push(...subChunks);
            }
        }

        return chunks;
    }

    /**
     * Split a large section at double-newline paragraph boundaries.
     * The section heading is prepended to the first sub-chunk so the embedding
     * always has the heading context. Subsequent sub-chunks carry the heading
     * as a suffix note to preserve retrieval context.
     */
    private splitAtParagraphs(
        body: string,
        heading: string | undefined,
        filePath: string,
        tags: string[],
        fileType: string,
    ): Omit<RawChunk, 'chunkIndex' | 'totalChunks'>[] {
        const paragraphs = body.split(/\n\n+/);
        const subChunks: Omit<RawChunk, 'chunkIndex' | 'totalChunks'>[] = [];
        let buffer = heading ? `${heading}\n\n` : '';

        for (const paragraph of paragraphs) {
            const candidate = buffer + paragraph;
            if (candidate.length > this.config.maxChunkChars && buffer.trim().length > 0) {
                // Flush the buffer before this paragraph overflows it
                if (buffer.trim().length >= this.config.minChunkChars) {
                    subChunks.push({ filePath, heading, content: buffer.trim(), fileType, tags });
                }
                // Start new buffer — carry heading context as a suffix note
                buffer = heading ? `(continued from: ${heading})\n\n${paragraph}\n\n` : `${paragraph}\n\n`;
            } else {
                buffer = candidate + '\n\n';
            }
        }

        if (buffer.trim().length >= this.config.minChunkChars) {
            subChunks.push({ filePath, heading, content: buffer.trim(), fileType, tags });
        }

        return subChunks;
    }

    // =========================================================================
    // Tags
    // =========================================================================

    /**
     * Derive kebab-case tags from the file path directory segments.
     * 'docs/architecture/overview.md' → ['docs', 'architecture']
     */
    private tagsFromPath(filePath: string): string[] {
        const parts = filePath.split('/');
        // Drop the filename, keep directory segments
        return parts
            .slice(0, -1)
            .filter(p => p.length > 0 && p !== '.' && !p.startsWith('_'));
    }
}
