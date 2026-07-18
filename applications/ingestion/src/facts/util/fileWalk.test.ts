/** @format */
import { describe, it, expect } from '@jest/globals';
import { isTextCandidate } from './fileWalk.js';

describe('isTextCandidate', () => {
    it('accepts source + config extensions', () => {
        for (const f of ['a.ts','b.py','c.go','d.rs','e.java','Dockerfile','f.tf','g.yaml','README.md','001_init.sql']) {
            expect(isTextCandidate(f)).toBe(true);
        }
    });
    it('rejects binaries and images', () => {
        for (const f of ['x.png','y.jpg','z.pdf','w.so','v.wasm']) {
            expect(isTextCandidate(f)).toBe(false);
        }
    });
});
