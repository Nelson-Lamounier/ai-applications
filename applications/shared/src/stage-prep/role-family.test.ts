import { describe, it, expect } from '@jest/globals';
import { toRoleFamily, toCompSeniority } from './role-family.js';

describe('toRoleFamily', () => {
    it('maps common backend titles', () => {
        expect(toRoleFamily('Senior Backend Engineer')).toBe('backend');
        expect(toRoleFamily('Platform / DevOps Engineer')).toBe('devops');
        expect(toRoleFamily('Frontend Developer')).toBe('frontend');
        expect(toRoleFamily('Machine Learning Engineer')).toBe('ml');
    });
    it('falls back to "*" when no keyword matches', () => {
        expect(toRoleFamily('Chief Happiness Officer')).toBe('*');
    });
});

describe('toCompSeniority', () => {
    it('passes through the project StageId set', () => {
        expect(toCompSeniority('junior')).toBe('junior');
        expect(toCompSeniority('mid')).toBe('mid');
        expect(toCompSeniority('senior')).toBe('senior');
        expect(toCompSeniority('staff')).toBe('staff');
    });
    it('defaults null/unknown to "mid"', () => {
        expect(toCompSeniority(null)).toBe('mid');
        expect(toCompSeniority('wizard')).toBe('mid');
    });
});
