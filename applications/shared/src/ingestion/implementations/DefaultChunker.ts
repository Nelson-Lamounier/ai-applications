/**
 * @format
 * DefaultChunker — IChunker fallback for non-markdown files
 *
 * Handles code files (.ts, .py, .js, .yaml, .json etc.) by splitting on
 * line count. Not heading-aware — treats the file as a sequence of lines.
 *
 * Splitting strategy:
 *   - Divide file into overlapping windows of `linesPerChunk` lines
 *   - `overlapLines` lines of overlap between consecutive chunks preserves
 *     context across chunk boundaries (e.g. a function signature in chunk N
 *     is visible in chunk N+1 even if the body continues there)
 *   - Empty chunks (only whitespace) are discarded
 *
 * Future:
 *   A CodeChunker using a language-aware parser (e.g. tree-sitter) could
 *   replace DefaultChunker for TypeScript/Python files — splitting at
 *   function/class/export boundaries rather than arbitrary line counts.
 *   DefaultChunker remains the safe fallback for any file type.
 */

import type { RawChunk } from '../../rds/types.js';
import type { IChunker } from '../interfaces/IChunker.js';

export interface DefaultChunkerConfig {
    /** Lines per chunk. Default: 80 (~2000 chars for typical code line length). */
    readonly linesPerChunk: number;
    /** Lines of overlap between consecutive chunks. Default: 10. */
    readonly overlapLines: number;
}

const DEFAULT_CONFIG: DefaultChunkerConfig = {
    linesPerChunk: 80,
    overlapLines:  10,
};

export class DefaultChunker implements IChunker {
    private readonly config: DefaultChunkerConfig;

    constructor(config: Partial<DefaultChunkerConfig> = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    /** Accepts everything — used as the catch-all in ChunkerRegistry. */
    canHandle(_filePath: string): boolean {
        return true;
    }

    chunk(content: string, filePath: string): RawChunk[] {
        const ext      = filePath.split('.').pop() ?? '';
        const fileType = ext || 'text';
        const tags     = this.tagsFromPath(filePath);
        const lines    = content.split('\n');

        const { linesPerChunk, overlapLines } = this.config;
        const stride = linesPerChunk - overlapLines;

        const windows: string[] = [];
        for (let start = 0; start < lines.length; start += stride) {
            const window = lines.slice(start, start + linesPerChunk).join('\n').trim();
            if (window.length > 0) windows.push(window);
            if (start + linesPerChunk >= lines.length) break;
        }

        // Single chunk if file fits entirely in one window
        if (windows.length === 0 && content.trim().length > 0) {
            windows.push(content.trim());
        }

        return windows.map((windowContent, i) => ({
            filePath,
            content:     windowContent,
            fileType,
            tags,
            chunkIndex:  i,
            totalChunks: windows.length,
        }));
    }

    private tagsFromPath(filePath: string): string[] {
        const parts = filePath.split('/');
        return parts
            .slice(0, -1)
            .filter(p => p.length > 0 && p !== '.' && !p.startsWith('_'));
    }
}
