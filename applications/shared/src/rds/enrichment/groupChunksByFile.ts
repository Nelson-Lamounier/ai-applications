/** @format */
import type { RawChunk } from '../types.js';

/**
 * One enrichment unit = the grouping a single model call covers. Per-file
 * granularity (feature 002): instead of one Bedrock call per chunk, make one
 * call per file (or per bounded slice of a very large file) and fan the result
 * back to the file's chunks. On the reference repo this is ~1,066 files vs
 * ~3,932 chunks — a ~3.7x call reduction.
 */
export interface FileEnrichUnit {
    readonly filePath: string;
    /** Member chunks, ordered by chunkIndex. A unit's skills fan back to these. */
    readonly chunks: RawChunk[];
    /** Concatenated chunk content, capped at the model input budget. */
    readonly text: string;
}

/** Join member chunk content for the model call. Heading + content per chunk. */
function unitText(chunks: RawChunk[]): string {
    return chunks
        .map((c) => (c.heading ? `## ${c.heading}\n${c.content}` : c.content))
        .join('\n\n');
}

/**
 * Group chunks into per-file enrichment units, ordered by chunkIndex.
 *
 * A file whose concatenated text exceeds `maxInputChars` is split into more than
 * one unit, each within budget (so no model call is over-sized — spec edge case
 * 2). A single-chunk file yields a single-chunk unit, so per-file granularity is
 * never MORE expensive than per-chunk (edge case 1). Pure + deterministic.
 */
export function groupChunksByFile(
    chunks: readonly RawChunk[],
    maxInputChars: number,
): FileEnrichUnit[] {
    // Preserve first-seen file order; collect each file's chunks.
    const byFile = new Map<string, RawChunk[]>();
    for (const c of chunks) {
        const list = byFile.get(c.filePath);
        if (list) list.push(c);
        else byFile.set(c.filePath, [c]);
    }

    const units: FileEnrichUnit[] = [];
    for (const [filePath, fileChunks] of byFile) {
        const ordered = [...fileChunks].sort((a, b) => a.chunkIndex - b.chunkIndex);

        // Greedily pack chunks into ≤budget slices. A single chunk over budget
        // still forms its own slice (the enricher/Bedrock caps tokens itself).
        let slice: RawChunk[] = [];
        let sliceLen = 0;
        for (const c of ordered) {
            const add = c.content.length + (c.heading?.length ?? 0) + 4;
            if (slice.length > 0 && sliceLen + add > maxInputChars) {
                units.push({ filePath, chunks: slice, text: unitText(slice) });
                slice = [];
                sliceLen = 0;
            }
            slice.push(c);
            sliceLen += add;
        }
        if (slice.length > 0) {
            units.push({ filePath, chunks: slice, text: unitText(slice) });
        }
    }
    return units;
}
