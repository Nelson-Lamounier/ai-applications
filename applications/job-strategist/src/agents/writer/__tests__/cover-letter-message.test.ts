/** @format */
import { describe, it, expect } from '@jest/globals';
import { buildCoverLetterMessage, type CoverLetterMessageInput } from '../cover-letter-message.js';
import type { StructuredResumeData } from '@bedrock/shared';

const resumeBody = (): StructuredResumeData =>
    ({
        profile: { name: 'Nelson', title: 'Engineer', location: 'UK', email: 'n@x.com' },
        summary: 'Built production AI systems end-to-end.',
        experience: [
            { company: 'Acme', title: 'Cloud Support Engineer', period: '2023-2025', highlights: ['Cut MTTR by half via automated diagnostics.'] },
        ],
        skills: [],
        education: [],
        certifications: [],
        projects: [{ name: 'Tucaken', description: 'AI portfolio platform.', highlights: ['Migrated self-managed k8s to EKS.'] }],
        keyAchievements: [],
    }) as unknown as StructuredResumeData;

const base = (): CoverLetterMessageInput => ({
    targetRole: 'Technical Services Engineer',
    targetCompany: 'Acme Corp',
});

describe('buildCoverLetterMessage', () => {
    it('emits target role and target company', () => {
        const msg = buildCoverLetterMessage(base());
        expect(msg).toContain('Target role: Technical Services Engineer');
        expect(msg).toContain('Target company: Acme Corp');
    });

    it('emits the company problem section only when provided', () => {
        const withProblem = buildCoverLetterMessage({ ...base(), companyProblem: 'They need faster onboarding.' });
        expect(withProblem).toContain('The Problem This Role Solves');
        expect(withProblem).toContain('They need faster onboarding.');

        const without = buildCoverLetterMessage(base());
        expect(without).not.toContain('The Problem This Role Solves');
    });

    it('emits achievement evidence only when provided', () => {
        const with_ = buildCoverLetterMessage({ ...base(), achievementEvidence: 'Shipped a zero-downtime migration.' });
        expect(with_).toContain('Achievement & Impact Evidence');
        expect(with_).toContain('Shipped a zero-downtime migration.');

        const without = buildCoverLetterMessage(base());
        expect(without).not.toContain('Achievement & Impact Evidence');
    });

    it('emits the candidate contact block with the VERBATIM label, only when provided', () => {
        const with_ = buildCoverLetterMessage({ ...base(), candidateContact: 'Name: Nelson\nEmail: n@x.com' });
        expect(with_).toContain('Candidate Contact');
        expect(with_).toContain('VERBATIM');
        expect(with_).toContain('Name: Nelson');

        const without = buildCoverLetterMessage(base());
        expect(without).not.toContain('Candidate Contact');
    });

    it('emits the years-gap framing line only when provided', () => {
        const with_ = buildCoverLetterMessage({ ...base(), yearsGapFraming: 'Three years of relevant infra work across two roles.' });
        expect(with_).toContain('YEARS GAP FRAMING');
        expect(with_).toContain('Three years of relevant infra work across two roles.');

        const without = buildCoverLetterMessage(base());
        expect(without).not.toContain('YEARS GAP FRAMING');
    });

    it('emits profile intelligence only when provided', () => {
        const with_ = buildCoverLetterMessage({ ...base(), profileIntelligence: 'Code proves deeper k8s ownership than the resume states.' });
        expect(with_).toContain('Profile Intelligence');
        expect(with_).toContain('Code proves deeper k8s ownership');

        const without = buildCoverLetterMessage(base());
        expect(without).not.toContain('Profile Intelligence');
    });

    it('emits the resume body echo section (summary + experience + projects) only when resumeBody is provided', () => {
        const with_ = buildCoverLetterMessage({ ...base(), resumeBody: resumeBody() });
        expect(with_).toContain('## Resume body (echo source');
        expect(with_).toContain('Built production AI systems end-to-end.');
        expect(with_).toContain('Cloud Support Engineer @ Acme (2023-2025)');
        expect(with_).toContain('Cut MTTR by half via automated diagnostics.');
        expect(with_).toContain('Tucaken');
        expect(with_).toContain('Migrated self-managed k8s to EKS.');

        const without = buildCoverLetterMessage(base());
        expect(without).not.toContain('## Resume body (echo source');
    });

    it('omits every optional section entirely when the input carries only the required fields', () => {
        const msg = buildCoverLetterMessage(base());
        expect(msg).not.toContain('The Problem This Role Solves');
        expect(msg).not.toContain('Achievement & Impact Evidence');
        expect(msg).not.toContain('Candidate Contact');
        expect(msg).not.toContain('YEARS GAP FRAMING');
        expect(msg).not.toContain('Profile Intelligence');
        expect(msg).not.toContain('## Resume body (echo source');
    });
});
