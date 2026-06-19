/** @format */

/**
 * One chunk to enrich in a pack (feature 004 chunk-packing). `key` is the stable
 * attribution id the packed response is keyed by (db id, or filePath::chunkIndex)
 * — never positional, so a dropped/reordered model entry still maps correctly.
 */
export interface PackItem {
    readonly key: string;
    readonly filePath: string;
    readonly content: string;
    readonly heading?: string;
}

/** A group of items sent in ONE model call (≤ packSize, combined content ≤ maxChars). */
export interface ChunkPack {
    readonly items: PackItem[];
}

function itemLen(it: PackItem): number {
    return it.content.length + (it.heading?.length ?? 0);
}

/**
 * Group items into packs for one model call each — greedy fill bounded by BOTH a
 * count (`packSize`) and a combined-content budget (`maxChars`, a cheap token
 * proxy). A single item larger than `maxChars` forms its OWN one-item pack (it
 * degrades to a per-chunk call, never dropped — spec FR-005). Pure, order-
 * preserving, deterministic.
 */
export function packChunks(items: readonly PackItem[], packSize: number, maxChars: number): ChunkPack[] {
    const packs: ChunkPack[] = [];
    let current: PackItem[] = [];
    let currentChars = 0;

    for (const it of items) {
        const len = itemLen(it);
        // Flush before adding when the current pack is non-empty and would breach
        // either bound. (An over-large lone item is added to an empty pack, then
        // flushed on its own at the next iteration.)
        if (current.length > 0 && (current.length >= packSize || currentChars + len > maxChars)) {
            packs.push({ items: current });
            current = [];
            currentChars = 0;
        }
        current.push(it);
        currentChars += len;
    }
    if (current.length > 0) packs.push({ items: current });
    return packs;
}
