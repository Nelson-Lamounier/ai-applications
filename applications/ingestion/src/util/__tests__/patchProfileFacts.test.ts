/** @format */
import { classifyAuthorshipRole, classifyRoleByShare, classifyCollaboration } from '../patchProfileFacts.js';

describe('classifyRoleByShare', () => {
    it('maps owner-dominance share to role at the 0.6/0.2 thresholds', () => {
        expect(classifyRoleByShare(0.98)).toBe('creator');
        expect(classifyRoleByShare(0.6)).toBe('creator');
        expect(classifyRoleByShare(0.59)).toBe('maintainer');
        expect(classifyRoleByShare(0.2)).toBe('maintainer');
        expect(classifyRoleByShare(0.19)).toBe('contributor');
    });
});

describe('classifyCollaboration', () => {
    it('maps contributor count to a team-size signal (null when no roster)', () => {
        expect(classifyCollaboration(0)).toBeNull();
        expect(classifyCollaboration(1)).toBe('solo');
        expect(classifyCollaboration(4)).toBe('small-team');
        expect(classifyCollaboration(5)).toBe('team');
        expect(classifyCollaboration(40)).toBe('team');
    });
});

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
