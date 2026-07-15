/** @format */
import { describe, it, expect } from '@jest/globals';
import { buildAnalysisMessage } from '../analysis-message.js';

const research = {
    targetRole: 'Platform Engineer',
    targetCompany: 'Acme Corp',
    seniority: 'Senior',
    domain: 'Platform Engineering',
    companyProblem: 'Reliability regressed after the last migration.',
    dimensionMix: { customerFacing: 0, technical: 80, aiMl: 0, supportOps: 10, monitoring: 10 },
    hardRequirements: [{ skill: 'Kubernetes', context: 'daily driver', disqualifying: true }],
    softRequirements: [{ skill: 'Terraform', context: 'nice to have' }],
    implicitRequirements: ['on-call rotation'],
    technologyInventory: { languages: ['TypeScript'], frameworks: [], infrastructure: ['EKS'], tools: [], methodologies: [] },
    verifiedMatches: [{ skill: 'Kubernetes', sourceCitation: 'infra/eks.ts', depth: 'expert', recency: 'current' }],
    partialMatches: [{ skill: 'Terraform', gapDescription: 'no direct Terraform use', transferableFoundation: 'AWS CDK TypeScript', framingSuggestion: 'declarative IaC, different tool' }],
    gaps: [{ skill: 'Ansible', gapType: 'soft', impactSeverity: 'minor', disqualifyingAssessment: 'not disqualifying' }],
    overallFitRating: 'REASONABLE FIT',
    fitSummary: 'Solid platform alignment.',
    resumeConstraints: 'Never claim SLA compliance.',
};

const base = {
    research: research as never,
    codeStack: 'Current: EKS, Karpenter, Pod Identity',
    yearsGapFraming: '6 years of relevant platform experience',
    profileIntelligence: 'Code-demonstrated direction: Platform & Infrastructure, senior.',
};

describe('buildAnalysisMessage', () => {
    it('emits the research brief', () => {
        const msg = buildAnalysisMessage(base);
        expect(msg).toContain('## Research Agent Brief');
        expect(msg).toContain('Target Role: Platform Engineer');
        expect(msg).toContain('Target Company: Acme Corp');
    });

    it('emits the company problem, reworded to analysis framing (no summary/cover-letter authoring language)', () => {
        const msg = buildAnalysisMessage(base);
        expect(msg).toContain('### The Problem This Role Solves');
        expect(msg).toContain('Reliability regressed after the last migration.');
        expect(msg).toContain('Frame the fit narrative and gap mitigations around how the candidate SOLVES this problem');
        expect(msg).not.toContain('Lead the summary + cover letter');
    });

    it('emits the code stack, reworded away from bullet-writing instructions', () => {
        const msg = buildAnalysisMessage(base);
        expect(msg).toContain('Current: EKS, Karpenter, Pod Identity');
        expect(msg).toContain('When assessing fit and composing the gap-mitigation narrative');
        expect(msg).not.toContain('When writing experience bullets');
    });

    it('emits role emphasis, reworded away from summary/experience authoring language', () => {
        const msg = buildAnalysisMessage(base);
        expect(msg).toContain('### Role Emphasis');
        expect(msg).toContain('technical 80%');
        expect(msg).not.toContain('Lead and weight the summary + experience emphasis');
    });

    it('emits hard/soft/implicit requirements and the technology inventory', () => {
        const msg = buildAnalysisMessage(base);
        expect(msg).toContain('### Hard Requirements');
        expect(msg).toContain('Kubernetes');
        expect(msg).toContain('DISQUALIFYING');
        expect(msg).toContain('### Technology Inventory');
        expect(msg).toContain('Languages: TypeScript');
    });

    it('emits verified/partial/gap matches', () => {
        const msg = buildAnalysisMessage(base);
        expect(msg).toContain('### Verified Matches (Evidence-Backed)');
        expect(msg).toContain('### Partial Matches (Transferable)');
        expect(msg).toContain('### Gaps');
        expect(msg).toContain('Ansible');
    });

    it('emits resume constraints, reworded away from bullet-authoring language', () => {
        const msg = buildAnalysisMessage(base);
        expect(msg).toContain('### Resume Domain Constraints');
        expect(msg).toContain('Never claim SLA compliance.');
        expect(msg).toContain('when assessing fit, choosing the archetype, and');
        expect(msg).not.toContain('generating each bullet and section you');
    });

    it('emits years-gap framing, reworded to ground the fit rating (not the summary)', () => {
        const msg = buildAnalysisMessage(base);
        expect(msg).toContain('YEARS GAP FRAMING');
        expect(msg).toContain('6 years of relevant platform experience');
        expect(msg).not.toContain('lead the summary with this true relevant-experience framing');
    });

    it('emits profile intelligence under its own header, reworded away from the summary S3 framing', () => {
        const msg = buildAnalysisMessage(base);
        expect(msg).toContain('### Profile Intelligence');
        expect(msg).toContain('Code-demonstrated direction: Platform & Infrastructure, senior.');
        expect(msg).not.toContain("summary's S3 distinctive-angle source");
    });

    it('emits the closing directive, forbidding tailored_resume_json and cover_letter', () => {
        const msg = buildAnalysisMessage(base);
        expect(msg).toContain('Execute Phase 0 and Phases 1-3');
        expect(msg).toContain('Do NOT include <tailored_resume_json> or <cover_letter>');
    });

    it('omits company-problem, code-stack, role-emphasis, resume-constraints, years-gap, and profile-intelligence sections when their inputs are empty', () => {
        const bare = buildAnalysisMessage({
            research: {
                ...research,
                companyProblem: '',
                dimensionMix: { customerFacing: 0, technical: 0, aiMl: 0, supportOps: 0, monitoring: 0 },
                resumeConstraints: '',
            } as never,
            codeStack: '',
            yearsGapFraming: '',
        });
        expect(bare).not.toContain('The Problem This Role Solves');
        expect(bare).not.toContain('Role Emphasis');
        expect(bare).not.toContain('Resume Domain Constraints');
        expect(bare).not.toContain('YEARS GAP FRAMING');
        expect(bare).not.toContain('Profile Intelligence');
    });
});
