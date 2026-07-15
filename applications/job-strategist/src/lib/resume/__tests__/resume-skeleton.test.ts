/**
 * @format
 * buildSkeletonResume -- deterministic assembly of the pre-agent resume
 * skeleton: profile + education + certifications copied verbatim from their
 * sources, experience reduced to a roster (highlights filled by a later
 * agent), and every agent-owned section left empty for batch 1/2 to fill.
 */
import { describe, it, expect } from '@jest/globals';
import { buildSkeletonResume } from '../resume-skeleton.js';
import type { CareerEntry, EducationEntry, CertificationEntry } from '../../../agents/evidence/career-history.js';

const CAREER: CareerEntry[] = [
    { title: 'Cloud & DevOps Engineer', company: 'Freelance', period: '2022 - Present', highlights: ['built X', 'shipped Y'] },
    { title: 'QA Analyst', company: 'Meta via Accenture', period: '2021 - 2022', highlights: [] },
];

const EDUCATION: EducationEntry[] = [
    { degree: 'BSc Computer Science', institution: 'Open University', period: '2018 - 2021' },
];

const CERTIFICATIONS: CertificationEntry[] = [
    { name: 'AWS Certified DevOps Engineer', issuer: 'AWS', date: '2023' },
];

const CONTACT = { name: 'Nelson Lamounier', email: 'nelson@example.com', linkedin: 'in/nelson', github: 'nelson-l', title: 'Cloud Engineer', location: 'Remote' };

describe('buildSkeletonResume', () => {
    it('maps the roster skeleton from careerEntries -- company/title/period verbatim, highlights empty', () => {
        const out = buildSkeletonResume({ careerEntries: CAREER, education: [], certifications: [], contact: CONTACT });
        expect(out.experience).toEqual([
            { company: 'Freelance', title: 'Cloud & DevOps Engineer', period: '2022 - Present', highlights: [] },
            { company: 'Meta via Accenture', title: 'QA Analyst', period: '2021 - 2022', highlights: [] },
        ]);
    });

    it('yields an empty experience array when there are zero career entries', () => {
        const out = buildSkeletonResume({ careerEntries: [], education: [], certifications: [], contact: CONTACT });
        expect(out.experience).toEqual([]);
    });

    it('maps education verbatim (degree/institution/period)', () => {
        const out = buildSkeletonResume({ careerEntries: [], education: EDUCATION, certifications: [], contact: CONTACT });
        expect(out.education).toEqual([
            { degree: 'BSc Computer Science', institution: 'Open University', period: '2018 - 2021' },
        ]);
    });

    it('maps certifications verbatim (name/issuer verbatim, date -> year)', () => {
        const out = buildSkeletonResume({ careerEntries: [], education: [], certifications: CERTIFICATIONS, contact: CONTACT });
        expect(out.certifications).toEqual([
            { name: 'AWS Certified DevOps Engineer', issuer: 'AWS', year: '2023' },
        ]);
    });

    it('copies the profile verbatim from contact', () => {
        const out = buildSkeletonResume({ careerEntries: [], education: [], certifications: [], contact: CONTACT });
        expect(out.profile).toEqual({
            name: 'Nelson Lamounier',
            title: 'Cloud Engineer',
            email: 'nelson@example.com',
            location: 'Remote',
            linkedin: 'in/nelson',
            github: 'nelson-l',
        });
    });

    it('defaults missing optional profile fields to empty strings, never inventing them', () => {
        const out = buildSkeletonResume({
            careerEntries: [], education: [], certifications: [],
            contact: { name: 'Jane Doe', email: 'jane@example.com' },
        });
        expect(out.profile).toEqual({ name: 'Jane Doe', title: '', email: 'jane@example.com', location: '' });
    });

    it('leaves every agent-owned section empty and sectionOrder undefined', () => {
        const out = buildSkeletonResume({ careerEntries: CAREER, education: EDUCATION, certifications: CERTIFICATIONS, contact: CONTACT });
        expect(out.summary).toBe('');
        expect(out.skills).toEqual([]);
        expect(out.projects).toEqual([]);
        expect(out.keyAchievements).toEqual([]);
        expect(out.sectionOrder).toBeUndefined();
    });
});
