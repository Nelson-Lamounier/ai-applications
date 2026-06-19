/** @format */
import { groupChunksByFile } from './groupChunksByFile.js';
import type { RawChunk } from '../types.js';

function chunk(filePath: string, chunkIndex: number, content: string, heading?: string): RawChunk {
    return { filePath, chunkIndex, content, heading, totalChunks: 0 };
}

describe('groupChunksByFile', () => {
    it('groups chunks of one file into a single unit, ordered by chunkIndex', () => {
        const units = groupChunksByFile(
            [chunk('a.ts', 2, 'two'), chunk('a.ts', 0, 'zero'), chunk('a.ts', 1, 'one')],
            10_000,
        );
        expect(units).toHaveLength(1);
        expect(units[0].filePath).toBe('a.ts');
        expect(units[0].chunks.map((c) => c.chunkIndex)).toEqual([0, 1, 2]);
        expect(units[0].text).toContain('zero');
        expect(units[0].text.indexOf('zero')).toBeLessThan(units[0].text.indexOf('one'));
    });

    it('produces one unit per distinct file (the call-reduction lever)', () => {
        const units = groupChunksByFile(
            [chunk('a.ts', 0, 'x'), chunk('b.ts', 0, 'y'), chunk('a.ts', 1, 'z')],
            10_000,
        );
        expect(units.map((u) => u.filePath).sort((a, b) => a.localeCompare(b))).toEqual(['a.ts', 'b.ts']);
        expect(units).toHaveLength(2); // 3 chunks -> 2 calls
    });

    it('degrades a single-chunk file to a single-chunk unit (never costs more)', () => {
        const units = groupChunksByFile([chunk('solo.md', 0, 'only')], 10_000);
        expect(units).toHaveLength(1);
        expect(units[0].chunks).toHaveLength(1);
    });

    it('splits a file that exceeds the input budget into bounded units', () => {
        const big = 'x'.repeat(60);
        const units = groupChunksByFile(
            [chunk('big.ts', 0, big), chunk('big.ts', 1, big), chunk('big.ts', 2, big)],
            100, // budget fits ~1 chunk (60+4) but not two
        );
        expect(units.length).toBeGreaterThan(1);
        expect(units.every((u) => u.filePath === 'big.ts')).toBe(true);
        // every slice within budget (a lone over-budget chunk is allowed its own slice)
        expect(units.every((u) => u.chunks.length === 1)).toBe(true);
    });

    it('includes the heading in the unit text when present', () => {
        const units = groupChunksByFile([chunk('a.ts', 0, 'body', 'Title')], 10_000);
        expect(units[0].text).toContain('Title');
        expect(units[0].text).toContain('body');
    });
});
