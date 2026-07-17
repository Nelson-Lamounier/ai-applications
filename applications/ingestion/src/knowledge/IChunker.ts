/**
 * @format
 * IChunker — Document Chunking Contract
 *
 * Splits file content into RawChunk[] ready for embedding.
 * Each implementation handles a specific file type.
 * ChunkerRegistry selects the right implementation via canHandle().
 *
 * Implementations are pure — no I/O, no async, no side effects.
 * This makes them trivially testable without any AWS calls.
 */

import type { RawChunk } from '@bedrock/shared';

export interface IChunker {
    /**
     * Returns true if this chunker knows how to handle the given file path.
     * Typically tests file extension. Called by ChunkerRegistry.
     */
    canHandle(filePath: string): boolean;

    /**
     * Split file content into one or more RawChunk objects.
     *
     * @param content  - Full raw file content as a UTF-8 string
     * @param filePath - Relative path within the repository
     * @returns        - Ordered array of chunks (chunkIndex 0…n-1, totalChunks = n)
     */
    chunk(content: string, filePath: string): RawChunk[];
}
