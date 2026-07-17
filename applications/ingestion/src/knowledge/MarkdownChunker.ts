/**
 * @format
 * MarkdownChunker — IChunker for Markdown and MDX files
 *
 * Pure class — no I/O, no async, no external dependencies.
 * Splits markdown into semantically coherent chunks based on heading structure.
 *
 * Chunking strategy:
 *   1. Parse YAML frontmatter (--- ... ---). Tags merge into chunk tags;
 *      remaining keys (title, type, sources, created, updated) flow into
 *      every chunk's `metadata` field.
 *   2. Strip Obsidian-style wikilinks: [[page]] → page, [[page|alias]] →
 *      alias, [[folder/page]] → page. Preserves the noun, drops the syntax.
 *   3. Split content on heading lines (# ## ### ####).
 *   4. Each heading + its body becomes a candidate chunk.
 *   5. Chunks exceeding maxChunkChars are split at paragraph boundaries.
 *   6. Empty chunks (heading only, no body) are discarded.
 *   7. Preamble (content before first heading) is kept if non-empty.
 *
 * Heading in chunk content:
 *   The heading line is included at the top of each chunk's content.
 *   This ensures the embedding captures the semantic context of the heading
 *   even when chunks are retrieved without surrounding context.
 *
 * Tags:
 *   Union of (a) directory segments of the file path, minus filename,
 *   minus '.', minus '_'-prefixed; and (b) the YAML frontmatter `tags`
 *   array if present. Lowercased + trimmed + deduplicated.
 */

import type { RawChunk } from '@bedrock/shared';
import type { IChunker } from './IChunker.js';

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

    /**
     * Characters of text carried from the end of a flushed chunk into the
     * start of the next. Improves retrieval of sentences that straddle chunk
     * boundaries — the embedding for each chunk "sees" the tail of its predecessor.
     * Set to 0 to disable overlap entirely.
     * Default: 200
     */
    readonly overlapChars: number;
}

const DEFAULT_CONFIG: MarkdownChunkerConfig = {
    maxChunkChars: 2000,
    minChunkChars: 30,
    overlapChars:  200,
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
        const fileType = filePath.endsWith('.mdx') ? 'mdx' : 'md';

        // 1. Parse frontmatter — pull tags out, keep remainder for metadata.
        const { body, frontmatter } = this.parseFrontmatter(content);

        // 2. Merge directory tags + frontmatter tags. Lowercase + dedupe.
        const directoryTags   = this.tagsFromPath(filePath);
        const frontmatterTags = Array.isArray(frontmatter['tags'])
            ? (frontmatter['tags'] as unknown[]).filter((t): t is string => typeof t === 'string')
            : [];
        const tags = Array.from(new Set([...directoryTags, ...frontmatterTags]))
            .map(t => t.toLowerCase().trim())
            .filter(Boolean);

        // 3. Frontmatter (minus tags) becomes per-chunk metadata. Empty object
        //    is fine — DB column has DEFAULT '{}'::jsonb.
        const { tags: _droppedTags, ...metadata } = frontmatter;

        // 4. Strip wikilinks before chunking — preserves the noun, drops the syntax.
        const cleaned = this.stripWikilinks(body);

        const sections = this.splitIntoSections(cleaned);
        const chunks   = this.sectionsToChunks(sections, filePath, tags, fileType, metadata);

        // Assign final chunkIndex / totalChunks after all splits are known
        return chunks.map((c, i) => ({ ...c, chunkIndex: i, totalChunks: chunks.length }));
    }

    // =========================================================================
    // Frontmatter
    // =========================================================================

    /**
     * Parse YAML frontmatter (`--- ... ---` at line 0) and return the body
     * with the frontmatter stripped, plus the parsed key/value map.
     *
     * Subset supported (covers the gold-standard `wiki/` shape):
     *   - `key: value` → string
     *   - `key: "quoted value"` → string with quotes stripped
     *   - `key: [a, b, c]` → string[] (inline array, comma-separated)
     *
     * Anything else (multi-line lists, nested objects) is dropped silently —
     * we accept the lossiness for now to avoid pulling in a YAML dependency.
     * Promote to `js-yaml` if/when frontmatter complexity grows.
     */
    private parseFrontmatter(content: string): {
        body: string;
        frontmatter: Record<string, unknown>;
    } {
        const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
        if (!match) return { body: content, frontmatter: {} };

        const body        = content.slice(match[0].length);
        const frontmatter: Record<string, unknown> = {};

        for (const rawLine of match[1].split(/\r?\n/)) {
            const line = rawLine.trimEnd();
            if (!line || line.startsWith('#')) continue;          // blank or comment

            const kv = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
            if (!kv) continue;
            const key = kv[1];
            const raw = kv[2].trim();

            // Inline array: [a, b, c]  /  ['a', "b", c]
            if (raw.startsWith('[') && raw.endsWith(']')) {
                const inner = raw.slice(1, -1).trim();
                if (inner.length === 0) {
                    frontmatter[key] = [];
                } else {
                    frontmatter[key] = inner
                        .split(',')
                        .map(s => s.trim().replace(/^['"]|['"]$/g, ''))
                        .filter(Boolean);
                }
                continue;
            }

            // Strip surrounding single/double quotes from scalar values.
            frontmatter[key] = raw.replace(/^['"]|['"]$/g, '');
        }

        return { body, frontmatter };
    }

    // =========================================================================
    // Wikilinks
    // =========================================================================

    /**
     * Replace Obsidian-style wikilinks with their human-readable text.
     *   [[page]]              → page
     *   [[folder/page]]       → page          (last segment wins)
     *   [[page|alias]]        → alias         (alias wins)
     *   [[folder/page|alias]] → alias
     *
     * Done in two passes so the alias form (which has both `/` and `|`) is
     * resolved before the no-alias form runs.
     */
    private stripWikilinks(text: string): string {
        return text
            // [[anything|alias]] → alias
            .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
            // [[folder/.../page]] → page
            .replace(/\[\[(?:[^\]/]+\/)?([^\]]+)\]\]/g, '$1');
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
        metadata: Record<string, unknown>,
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
                    metadata,
                });
            } else {
                // Split at paragraph boundaries and carry heading into each sub-chunk
                const subChunks = this.splitAtParagraphs(
                    section.content,
                    section.heading,
                    filePath,
                    tags,
                    fileType,
                    metadata,
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
     * as a continuation note plus an overlap tail from the previous chunk so
     * the embedding "sees" text that spans the boundary.
     */
    private splitAtParagraphs(
        body: string,
        heading: string | undefined,
        filePath: string,
        tags: string[],
        fileType: string,
        metadata: Record<string, unknown>,
    ): Omit<RawChunk, 'chunkIndex' | 'totalChunks'>[] {
        const paragraphs = body.split(/\n\n+/);
        const subChunks: Omit<RawChunk, 'chunkIndex' | 'totalChunks'>[] = [];
        let buffer = heading ? `${heading}\n\n` : '';

        for (const paragraph of paragraphs) {
            const candidate = buffer + paragraph;
            if (candidate.length > this.config.maxChunkChars && buffer.trim().length > 0) {
                // Flush the buffer before this paragraph overflows it
                if (buffer.trim().length >= this.config.minChunkChars) {
                    subChunks.push({ filePath, heading, content: buffer.trim(), fileType, tags, metadata });
                }
                // Carry the tail of the flushed buffer into the next chunk so
                // sentence fragments that cross the boundary appear in both.
                const overlapTail = this.config.overlapChars > 0
                    ? buffer.trimEnd().slice(-this.config.overlapChars)
                    : '';
                const continuationPrefix = heading ? `(continued from: ${heading})\n\n` : '';
                buffer = overlapTail.length > 0
                    ? `${continuationPrefix}...${overlapTail}\n\n${paragraph}\n\n`
                    : `${continuationPrefix}${paragraph}\n\n`;
            } else {
                buffer = candidate + '\n\n';
            }
        }

        if (buffer.trim().length >= this.config.minChunkChars) {
            subChunks.push({ filePath, heading, content: buffer.trim(), fileType, tags, metadata });
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
