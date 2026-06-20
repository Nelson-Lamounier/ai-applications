/** @format */
import { classifyAuthorshipRole } from './patchProfileFacts.js';

describe('classifyAuthorshipRole', () => {
    it('returns null when there is no commit history (caller skips the patch)', () => {
        expect(classifyAuthorshipRole(0, 0)).toBeNull();
    });

    it('owner authored the clear majority -> creator', () => {
        expect(classifyAuthorshipRole(894, 880)).toBe('creator');   // ~0.98
        expect(classifyAuthorshipRole(10, 6)).toBe('creator');      // 0.6 boundary (inclusive)
    });

    it('owner authored a meaningful share -> maintainer', () => {
        expect(classifyAuthorshipRole(100, 35)).toBe('maintainer'); // 0.35
        expect(classifyAuthorshipRole(10, 2)).toBe('maintainer');   // 0.2 boundary (inclusive)
    });

    it('owner authored a small share of someone else\'s repo -> contributor', () => {
        expect(classifyAuthorshipRole(100, 5)).toBe('contributor'); // 0.05
        expect(classifyAuthorshipRole(894, 0)).toBe('contributor'); // none by owner
    });
});
