/** @format */
import { describe, it, expect } from '@jest/globals';
import { createSafeExtractFilter, safeFilter } from './safeExtract.js';

describe('safeFilter', () => {
    it('accepts a normal nested file', () => {
        expect(safeFilter('root-abc/src/index.ts', { type: 'File' } as never)).toBe(true);
    });
    it('rejects path traversal (zip-slip)', () => {
        expect(safeFilter('root-abc/../../etc/passwd', { type: 'File' } as never)).toBe(false);
    });
    it('rejects symlinks and hardlinks', () => {
        expect(safeFilter('root-abc/link', { type: 'SymbolicLink' } as never)).toBe(false);
        expect(safeFilter('root-abc/link', { type: 'Link' } as never)).toBe(false);
    });
    it('rejects absolute paths', () => {
        expect(safeFilter('/etc/passwd', { type: 'File' } as never)).toBe(false);
    });
});

describe('createSafeExtractFilter', () => {
    it('rejects an extracted file larger than the per-file cap', () => {
        const filter = createSafeExtractFilter({ maxEntries: 10, maxTotalBytes: 10_000, maxFileBytes: 100 });
        expect(() => filter('root/big.bin', { type: 'File', size: 101 } as never)).toThrow(/file too large/i);
    });

    it('rejects when cumulative extracted bytes exceed the total cap', () => {
        const filter = createSafeExtractFilter({ maxEntries: 10, maxTotalBytes: 150, maxFileBytes: 150 });
        expect(filter('root/a.ts', { type: 'File', size: 100 } as never)).toBe(true);
        expect(() => filter('root/b.ts', { type: 'File', size: 60 } as never)).toThrow(/extracted bytes/i);
    });
});
