/** @format */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from '@jest/globals';
import { isTextCandidate, readTextFileWithinLimit, walkTextFiles } from './fileWalk.js';

describe('isTextCandidate', () => {
    it('accepts source + config extensions', () => {
        for (const f of ['a.ts','b.py','c.go','d.rs','e.java','Dockerfile','f.tf','g.yaml','README.md']) {
            expect(isTextCandidate(f)).toBe(true);
        }
    });
    it('rejects binaries and images', () => {
        for (const f of ['x.png','y.jpg','z.pdf','w.so','v.wasm']) {
            expect(isTextCandidate(f)).toBe(false);
        }
    });
});

describe('walkTextFiles', () => {
    it('skips text candidates larger than the configured cap', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'walk-text-'));
        await fs.writeFile(path.join(root, 'small.ts'), 'const x = 1;');
        await fs.writeFile(path.join(root, 'large.ts'), 'x'.repeat(20));

        await expect(walkTextFiles(root, { maxFileBytes: 15 })).resolves.toEqual(['small.ts']);

        await fs.rm(root, { recursive: true, force: true });
    });
});

describe('readTextFileWithinLimit', () => {
    it('rejects before reading oversized text files', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'read-text-'));
        await fs.writeFile(path.join(root, 'large.ts'), 'x'.repeat(20));

        await expect(readTextFileWithinLimit(root, 'large.ts', 10)).rejects.toThrow(/file too large/i);

        await fs.rm(root, { recursive: true, force: true });
    });
});
