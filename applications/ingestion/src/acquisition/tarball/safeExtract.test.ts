/** @format */
import { describe, it, expect } from '@jest/globals';
import { safeFilter } from './safeExtract.js';

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
