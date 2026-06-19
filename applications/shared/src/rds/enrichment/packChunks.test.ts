/** @format */
import { packChunks, type PackItem } from './packChunks.js';

function item(key: string, content: string): PackItem {
    return { key, filePath: 'f.ts', content };
}

describe('packChunks', () => {
    it('fills up to packSize then starts a new pack', () => {
        const items = ['a', 'b', 'c', 'd', 'e'].map((k) => item(k, 'x'));
        const packs = packChunks(items, 2, 10_000);
        expect(packs.map((p) => p.items.length)).toEqual([2, 2, 1]);
        expect(packs[0].items.map((i) => i.key)).toEqual(['a', 'b']);
    });

    it('starts a new pack when the char budget would be exceeded', () => {
        const items = [item('a', 'x'.repeat(60)), item('b', 'x'.repeat(60))];
        const packs = packChunks(items, 50, 100); // 2 fit by count, not by chars
        expect(packs).toHaveLength(2);
        expect(packs[0].items.map((i) => i.key)).toEqual(['a']);
    });

    it('an over-large single item forms its own pack (never dropped)', () => {
        const items = [item('big', 'x'.repeat(500)), item('a', 'x'), item('b', 'x')];
        const packs = packChunks(items, 50, 100);
        expect(packs[0].items.map((i) => i.key)).toEqual(['big']);   // alone, over budget
        expect(packs.flatMap((p) => p.items.map((i) => i.key))).toEqual(['big', 'a', 'b']); // none lost
    });

    it('preserves input order across packs', () => {
        const items = ['a', 'b', 'c', 'd'].map((k) => item(k, 'x'));
        const packs = packChunks(items, 2, 10_000);
        expect(packs.flatMap((p) => p.items.map((i) => i.key))).toEqual(['a', 'b', 'c', 'd']);
    });

    it('returns [] for no items', () => {
        expect(packChunks([], 20, 1000)).toEqual([]);
    });
});
