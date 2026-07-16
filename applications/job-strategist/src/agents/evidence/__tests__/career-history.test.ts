import { describe, it, expect } from '@jest/globals';
import { formatCareerHistory, formatEducation, formatCertifications, formatExperienceFacts } from '../career-history.js';
import type { CareerEntry, EducationEntry, CertificationEntry } from '../career-history.js';

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

const CERTS: CertificationEntry[] = [
    { name: 'AWS Certified DevOps Engineer - Professional', issuer: 'Amazon Web Services', date: '2024' },
];
describe('formatCertifications', () => {
    it('renders the cert verbatim and instructs the matcher to weigh JD relevance', () => {
        const out = formatCertifications(CERTS);
        expect(out).toContain('VERIFIED CERTIFICATIONS');
        expect(out).toContain('AWS Certified DevOps Engineer - Professional');
        expect(out).toMatch(/WEIGH each against the JD/i);   // relevance directive present
        expect(out).toMatch(/reinforces a match/i);
    });
    it('returns empty string for no entries', () => {
        expect(formatCertifications([])).toBe('');
    });
});

describe('formatExperienceFacts', () => {
    it('lists company + title + period verbatim with a no-rename directive', () => {
        const out = formatExperienceFacts(ENTRIES);
        expect(out).toContain('VERIFIED EXPERIENCE');
        expect(out).toContain('VERBATIM');
        expect(out).toContain('never rename or re-title a role');
        expect(out).toContain('Senior Platform Engineer — Acme (2021–2024)');
    });
    it('returns empty string for no entries', () => {
        expect(formatExperienceFacts([])).toBe('');
    });
});

describe('computeVerifiedYears — from career-history periods', () => {
	it('sums distinct employment years across entries, honouring Present', async () => {
		const { computeVerifiedYears } = await import('../career-history.js');
		const years = computeVerifiedYears([
			{ title: 'a', company: 'AWS', period: '2021 – 2024', highlights: [] },
			{ title: 'b', company: 'Meta', period: '2019 - 2021', highlights: [] },
		]);
		expect(years).toBe(5);
	});
	it('returns null when no period parses', async () => {
		const { computeVerifiedYears } = await import('../career-history.js');
		expect(computeVerifiedYears([{ title: 'a', company: 'x', period: 'n/a', highlights: [] }])).toBeNull();
	});
});

describe('loadCertifications - year field fallback', () => {
    // The resume importer persists the certification date under `year`; the
    // loader previously read only date/period, so a year-keyed row produced
    // date:'' -> certifications[].year:'' -> the persist gate (min 1 char)
    // rejected the WHOLE resume and the UI's resumes row silently went stale.
    it('falls back to raw_data.year when date and period are absent', async () => {
        const pool = {
            query: async () => ({
                rows: [{ raw_data: { name: 'AWS Certified DevOps Engineer - Professional', issuer: 'Amazon Web Services', year: '2025' } }],
            }),
        };
        const { loadCertifications } = await import('../career-history.js');
        const entries = await loadCertifications(pool as never, 'user-1');
        expect(entries).toEqual([
            { name: 'AWS Certified DevOps Engineer - Professional', issuer: 'Amazon Web Services', date: '2025' },
        ]);
    });

    it('prefers date over period over year when several are present', async () => {
        const pool = {
            query: async () => ({
                rows: [{ raw_data: { name: 'Cert', issuer: 'Org', date: '2024', period: '2023', year: '2022' } }],
            }),
        };
        const { loadCertifications } = await import('../career-history.js');
        const entries = await loadCertifications(pool as never, 'user-1');
        expect(entries[0]?.date).toBe('2024');
    });
});
