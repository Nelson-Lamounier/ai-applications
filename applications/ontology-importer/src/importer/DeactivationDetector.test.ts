/** @format */
import { describe, it, expect } from '@jest/globals';
import { shouldDeactivate } from './DeactivationDetector.js';

describe('shouldDeactivate', () => {
    it('returns false below the default threshold', () => {
        expect(shouldDeactivate(2)).toBe(false);
    });
    it('returns true at the default threshold', () => {
        expect(shouldDeactivate(3)).toBe(true);
    });
    it('returns true above the default threshold', () => {
        expect(shouldDeactivate(5)).toBe(true);
    });
    it('honors a custom threshold', () => {
        expect(shouldDeactivate(2, 2)).toBe(true);
    });
});
