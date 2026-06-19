/** @format */
import { describe, it, expect } from '@jest/globals';
import { readCapped } from './capped-fetch.js';

async function* chunks(...parts: string[]): AsyncIterable<Buffer> {
    for (const p of parts) yield Buffer.from(p);
}

describe('readCapped', () => {
    it('returns the full body when under the cap', async () => {
        const buf = await readCapped(chunks('hello ', 'world'), 1024);
        expect(buf.toString('utf-8')).toBe('hello world');
    });

    it('throws once the running total exceeds the byte cap', async () => {
        // 3 chunks of 4 bytes = 12; cap 8 → throws on the 3rd
        await expect(readCapped(chunks('aaaa', 'bbbb', 'cccc'), 8))
            .rejects.toThrow(/exceeded 8 byte cap/);
    });

    it('accepts a body exactly at the cap', async () => {
        const buf = await readCapped(chunks('abcd', 'efgh'), 8);
        expect(buf.length).toBe(8);
    });
});
