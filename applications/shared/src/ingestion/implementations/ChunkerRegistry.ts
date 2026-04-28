/**
 * @format
 * ChunkerRegistry — Routes files to the correct IChunker
 *
 * Single responsibility: given a file path, select and delegate to the
 * appropriate IChunker implementation. The orchestrator calls this class
 * and has no knowledge of which concrete chunker handles which file type.
 *
 * Registration order matters — the first chunker whose canHandle() returns
 * true is used. Register specialised chunkers before the DefaultChunker.
 */

import type { RawChunk } from '../../rds/types.js';
import type { IChunker } from '../interfaces/IChunker.js';
import { DefaultChunker } from './DefaultChunker.js';
import { MarkdownChunker } from './MarkdownChunker.js';

export class ChunkerRegistry {
    private readonly chunkers: IChunker[];

    /**
     * @param chunkers - Ordered list of chunkers. DefaultChunker should be last.
     */
    constructor(chunkers: IChunker[]) {
        if (chunkers.length === 0) {
            throw new Error('ChunkerRegistry: at least one chunker is required');
        }
        this.chunkers = chunkers;
    }

    /**
     * Select the first chunker that can handle the file and delegate.
     * Throws if no chunker matches — ensure DefaultChunker is registered last.
     */
    chunk(content: string, filePath: string): RawChunk[] {
        const chunker = this.chunkers.find(c => c.canHandle(filePath));
        if (!chunker) {
            throw new Error(
                `ChunkerRegistry: no chunker registered for file: ${filePath}`,
            );
        }
        return chunker.chunk(content, filePath);
    }

    /** Check whether any registered chunker can handle this path. */
    canHandle(filePath: string): boolean {
        return this.chunkers.some(c => c.canHandle(filePath));
    }

    /**
     * Build the default registry for portfolio repository ingestion.
     *
     * Registration order is load-bearing:
     *   1. MarkdownChunker — handles .md / .mdx with heading-aware splitting
     *   2. DefaultChunker  — catch-all, accepts everything else
     *
     * DefaultChunker MUST be last. Because its canHandle() always returns true,
     * placing it earlier would prevent any subsequent chunker from being reached.
     */
    static withDefaults(): ChunkerRegistry {
        return new ChunkerRegistry([
            new MarkdownChunker(),
            new DefaultChunker(),  // catch-all — must be last
        ]);
    }
}
