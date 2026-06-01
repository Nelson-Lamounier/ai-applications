import { describe, it, expect } from '@jest/globals';
import { formatCareerHistory } from './career-history.js';
import type { CareerEntry } from './career-history.js';

const ENTRIES: CareerEntry[] = [
    { title: 'Senior Platform Engineer', company: 'Acme', period: '2021–2024', highlights: ['Led migration to EKS', 'Cut MTTR 40%'] },
    { title: 'Backend Engineer', company: 'Beta', period: '2018–2021', highlights: [] },
];
describe('formatCareerHistory', () => {
    it('renders a citeable career-history section', () => {
        const out = formatCareerHistory(ENTRIES);
        expect(out).toContain('Career History');
        expect(out).toContain('Senior Platform Engineer');
        expect(out).toContain('Acme');
        expect(out).toContain('Led migration to EKS');
    });
    it('returns empty string for no entries', () => {
        expect(formatCareerHistory([])).toBe('');
    });
});
