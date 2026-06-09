import { describe, it, expect } from '@jest/globals';
import { formatCareerHistory, formatEducation } from './career-history.js';
import type { CareerEntry, EducationEntry } from './career-history.js';

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

const EDU: EducationEntry[] = [
    { degree: 'Higher Diploma in Science in Computing (Web & Cloud Technologies)', institution: 'Dublin Business School', period: '2022 - 2024' },
    { degree: 'BA (Honours) in Digital Marketing and Cloud Computing', institution: 'Dublin Business School', period: '2016 - 2020' },
];
describe('formatEducation', () => {
    it('renders degree + institution verbatim with a verbatim directive', () => {
        const out = formatEducation(EDU);
        expect(out).toContain('VERIFIED EDUCATION');
        expect(out).toContain('VERBATIM');
        expect(out).toContain('Higher Diploma in Science in Computing (Web & Cloud Technologies) — Dublin Business School');
        expect(out).toContain('BA (Honours) in Digital Marketing and Cloud Computing — Dublin Business School');
    });
    it('returns empty string for no entries', () => {
        expect(formatEducation([])).toBe('');
    });
});
