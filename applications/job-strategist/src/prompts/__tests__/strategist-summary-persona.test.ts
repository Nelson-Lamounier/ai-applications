/** @format */
import { describe, it, expect } from '@jest/globals';
import type { StrategistResearchResult, StructuredResumeData } from '@bedrock/shared';
import { STRATEGIST_SUMMARY_SYSTEM_PROMPT } from '../strategist-summary.js';
import { buildSummaryMessage } from '../../agents/writer/summary-message.js';

const joined = STRATEGIST_SUMMARY_SYSTEM_PROMPT.map((block) =>
    'text' in block ? block.text : ''
).join('\n');

describe('strategist-summary-persona — derives the resume summary from the Fit Summary (outward translation, gap language stripped)', () => {
    it('anchors S1-S4 on the Fit Summary thesis and strips gap/viability language (relocated from strategist-persona.test.ts: the body no longer composes the summary, this rule now lives solely in the summary agent prompt)', () => {
        expect(joined).toContain('DERIVE FROM THE FIT SUMMARY');
        expect(joined).toContain('OUTWARD-FACING TRANSLATION');
        const lower = joined.toLowerCase();
        // must instruct BOTH: keep the same thesis AND strip gap/viability wording
        expect(lower).toContain('same central thesis');
        expect(lower).toContain('strip every');
    });
});

describe('strategist-summary-persona v12 — summary calibration (from the ResMed Associate-JD review of run 77e325ea)', () => {
    it('S1 aligns to the JD role class and bans employer-name openings ("AWS … engineer" while employed at AWS reads as a title held there)', () => {
        expect(joined).toMatch(/ALIGNED TO THE JD'S OWN ROLE CLASS/);
        expect(joined).toMatch(/NEVER OPEN with an employer's name/);
    });

    it('caps rigor at ONE sentence per summary and gives associate/junior roles a forward-fit close (the live S3 slot was a second rigor close)', () => {
        expect(joined).toMatch(/AT MOST ONE rigor\/gating sentence/);
        expect(joined).toMatch(/grounded forward-fit close/);
    });

    it('calibrates tone to the JD level (depth + hunger for associate roles, ownership for senior) and names equivalence bridges explicitly (CDK -> CloudFormation)', () => {
        expect(joined).toMatch(/SENIORITY TONE/);
        expect(joined).toMatch(/EQUIVALENCE BRIDGES/);
        expect(joined).toMatch(/CDK \(CloudFormation\)/);
    });
});

describe('strategist-summary-persona S3 <-> summary-message cross-reference', () => {
    // Post-split, S3 is composed by the dedicated summary agent from the
    // focused message buildSummaryMessage() produces (not the full body
    // writer's message). Both sides must name the EXACT same heading
    // ("## Profile Intelligence") so the model reliably finds the section
    // (this is the class of bug that once shipped an empty S3 slot — run
    // 77e325ea). This test pins an exact match, not a tolerant regex.
    it('S3 names the literal "## Profile Intelligence" heading, and buildSummaryMessage emits that exact literal', () => {
        expect(joined).toContain('## Profile Intelligence');
        expect(joined).toMatch(/UNDERSOLD strengths/);

        const research = {
            targetRole: 'Backend Engineer', targetCompany: 'Acme', seniority: 'mid', domain: 'saas',
            overallFitRating: 'REASONABLE FIT', fitSummary: 'Strong backend match.',
            verifiedMatches: [], partialMatches: [], gaps: [],
            companyProblem: '', dimensionMix: null,
        } as unknown as StrategistResearchResult;

        const body = {
            summary: '', profile: {}, skills: [], education: [], certifications: [], keyAchievements: [], sectionOrder: [],
            experience: [], projects: [],
        } as unknown as StructuredResumeData;

        const message = buildSummaryMessage({
            research,
            body,
            profileIntelligence: 'code-demonstrated direction: infra depth',
            yearsGapFraming: '',
            achievementEvidence: '',
        });

        expect(message).toContain('## Profile Intelligence');
        expect(message).toContain('code-demonstrated direction: infra depth');
    });
});

describe('strategist-summary-persona v4 — profile-against-JD narrative + constraints', () => {
    it('frames the whole summary as a candidate profile measured against the JD (fit-thesis mirror)', () => {
        expect(joined).toContain('PROFILE THE CANDIDATE AGAINST THIS JD');
        expect(joined).toContain('restatement of the matcher');
    });

    it('instructs the summary to apply the Resume Domain Constraints and never claim an ABSENT skill', () => {
        expect(joined).toContain('RESPECT THE CONSTRAINTS');
        expect(joined).toContain('## Resume Domain Constraints');
    });

    // S1's fit-thesis source reference must name the EXACT heading buildSummaryMessage
    // emits ("## Fit Summary") — same exact-cross-ref discipline as the S3/Profile
    // Intelligence pin (a stale "Research Agent Brief above" pointed the model at a
    // section its focused message never carries).
    it('S1 references the literal "## Fit Summary" section, and buildSummaryMessage emits that exact heading', () => {
        expect(joined).toContain('"## Fit Summary"');

        const research = {
            targetRole: 'Backend Engineer', targetCompany: 'Acme', seniority: 'mid', domain: 'saas',
            overallFitRating: 'REASONABLE FIT', fitSummary: 'Strong backend match.',
            verifiedMatches: [], partialMatches: [], gaps: [],
            companyProblem: '', dimensionMix: null,
        } as unknown as StrategistResearchResult;

        const body = {
            summary: '', profile: {}, skills: [], education: [], certifications: [], keyAchievements: [], sectionOrder: [],
            experience: [], projects: [],
        } as unknown as StructuredResumeData;

        const message = buildSummaryMessage({ research, body, profileIntelligence: '', yearsGapFraming: '', achievementEvidence: '' });
        expect(message).toContain('## Fit Summary');
    });
});
