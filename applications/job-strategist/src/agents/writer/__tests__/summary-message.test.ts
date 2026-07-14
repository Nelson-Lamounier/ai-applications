/** @format */
import { describe, it, expect } from '@jest/globals';
import type { StrategistResearchResult, StructuredResumeData } from '@bedrock/shared';
import { buildSummaryMessage } from '../summary-message.js';

const RESEARCH = {
    targetRole: 'Backend Engineer', targetCompany: 'Acme', seniority: 'mid', domain: 'saas',
    overallFitRating: 'REASONABLE FIT', fitSummary: 'Strong backend match; on-call proven; Kafka transferable.',
    verifiedMatches: [{ skill: 'Node.js', depth: 'expert', sourceCitation: 'x', recency: '2026' }],
    partialMatches: [{ skill: 'Kafka', gapDescription: '', transferableFoundation: 'SQS/SNS', framingSuggestion: '' }],
    gaps: [{ skill: 'Go', gapType: 'soft', impactSeverity: 'minor', disqualifyingAssessment: '' }],
    companyProblem: 'Ship reliable APIs faster.', dimensionMix: null,
} as unknown as StrategistResearchResult;

const BODY = {
    summary: '', profile: {}, skills: [], education: [], certifications: [], keyAchievements: [], sectionOrder: [],
    experience: [{ company: 'AWS', title: 'Support Engineer', period: '2023-2025', highlights: ['Handled on-call for prod'] }],
    projects: [{ name: 'Tucaken', description: '', highlights: ['Built API'], github: '' }],
} as unknown as StructuredResumeData;

describe('buildSummaryMessage', () => {
    const msg = buildSummaryMessage({
        research: RESEARCH,
        body: BODY,
        profileIntelligence: 'undersold: infra depth',
        yearsGapFraming: '3 relevant years',
        achievementEvidence: '',
    });

    it('includes the Fit Summary as the source of truth', () => {
        expect(msg).toContain('Strong backend match');
    });

    it('lists the finished experience + project highlights for altitude checks', () => {
        expect(msg).toContain('Handled on-call for prod');
        expect(msg).toContain('Built API');
    });

    it('surfaces gaps so the summary never claims them', () => {
        expect(msg).toContain('Go');
    });

    it('carries the profile intelligence for S3', () => {
        expect(msg).toContain('undersold: infra depth');
    });

    it('omits the constraints section when research carries none', () => {
        expect(msg).not.toContain('Resume Domain Constraints');
    });

    it('includes the resume domain constraints (applied before/after each beat) when present', () => {
        const withConstraints = buildSummaryMessage({
            research: { ...RESEARCH, resumeConstraints: 'NEVER claim Kubernetes (ABSENT from the KB).' } as unknown as StrategistResearchResult,
            body: BODY,
            profileIntelligence: '',
            yearsGapFraming: '',
            achievementEvidence: '',
        });
        expect(withConstraints).toContain('Resume Domain Constraints');
        expect(withConstraints).toContain('NEVER claim Kubernetes (ABSENT from the KB).');
    });

    it('does not throw and still renders the project name when a project has no highlights', () => {
        const bodyNoHighlights = {
            ...BODY,
            projects: [{ name: 'NoHighlightsProject', description: '', github: '' }],
        } as unknown as StructuredResumeData;

        let result = '';
        expect(() => {
            result = buildSummaryMessage({
                research: RESEARCH,
                body: bodyNoHighlights,
                profileIntelligence: '',
                yearsGapFraming: '',
                achievementEvidence: '',
            });
        }).not.toThrow();
        expect(result).toContain('NoHighlightsProject');
    });
});
