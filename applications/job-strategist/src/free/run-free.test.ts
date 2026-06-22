/** @format */
import { describe, it, expect, jest } from '@jest/globals';
import { runFreeTier } from './run-free.js';

describe('runFreeTier', () => {
    it('extracts JD, gathers evidence, writes resume, persists resume → meta → status → complete in order', async () => {
        const calls: string[] = [];

        const deps = {
            extractJdSignal: jest.fn(async (_jd: string) => ({
                requiredSkills:    ['AWS'],
                preferredSkills:   [],
                tools:             ['Kubernetes'],
                concepts:          [],
                responsibilities:  [],
                domain:            'cloud',
                seniority:         'senior',
                retrievalKeywords: ['aws'],
                companyProblem:    'secure cloud',
                targetRole:        'SSE',
                dimensionMix:      { customerFacing: 0, technical: 100, aiMl: 0, supportOps: 0, monitoring: 0 },
                hardRequirements:  [],
                softRequirements:  [],
                implicitRequirements: [],
                technologyInventory:  { languages: [], frameworks: [], infrastructure: [], tools: [], methodologies: [] },
                experienceSignals:    { yearsExpected: '', domainExperience: '', leadershipExpectation: '', scaleIndicators: '' },
            })) as never,
            gather: jest.fn(async () => ({
                kbPassages:     ['[Source: me/x]\nEKS'],
                projectEvidence: 'Tucaken',
                extractedTech:  'aws',
                careerFacts:    'Acme — Eng — 2022',
                educationFacts: '',
            })) as never,
            writer: {
                invoke: jest.fn(async () => ({
                    resume: {
                        profile:         { name: '', title: '', email: '', location: '' },
                        summary:         'I built X on AWS.',
                        experience:      [],
                        skills:          [],
                        education:       [],
                        certifications:  [],
                        projects:        [],
                        keyAchievements: [],
                    },
                    coverLetter: {
                        greeting:   'Dear Hiring Team,',
                        paragraphs: ['I am excited to apply for the SSE role.'],
                        signoff:    { name: '', email: '', linkedin: '', github: '' },
                    },
                })) as never,
            },
            aliasMap: jest.fn(async () => new Map<string, string>()) as never,
            persistResume: jest.fn(async () => {
                calls.push('resume');
                return { resumeId: 'r1' };
            }) as never,
            persistMeta: jest.fn(async (_pool: unknown, _id: unknown, _meta: unknown) => {
                calls.push('meta');
            }) as never,
            setStatus: jest.fn(async () => {
                calls.push('status');
            }) as never,
            complete: jest.fn(async () => {
                calls.push('complete');
            }) as never,
        };

        const env = {
            userId:        'u1',
            applicationId: 'app1',
            pipelineId:    'pipe1',
            pipelineRunId: 'run1',
            targetRole:    'SSE',
            targetCompany: 'Wiz',
            jobDescription: 'Build secure cloud infra with AWS and Kubernetes.',
        } as never;

        await runFreeTier({} as never, env, deps as never);

        expect(calls).toEqual(['resume', 'meta', 'status', 'complete']);

        // Verify ATS coverage is persisted as AtsCheckResult under analysis.atsCheck
        // (not the raw AtsCoverage under analysis.atsCoverage) so admin-api and
        // the UI AtsPanel can read it.
        const metaArg = (deps.persistMeta as ReturnType<typeof jest.fn>).mock.calls[0][2] as Record<string, unknown>;
        const analysis = metaArg['analysis'] as Record<string, unknown>;
        expect(analysis['atsCheck']).toBeDefined();
        expect(analysis['atsCoverage']).toBeUndefined();
        const atsCheck = analysis['atsCheck'] as { jdKeywordCoverage: { term: string; present: boolean }[] };
        // JD has requiredSkills=['AWS'], tools=['Kubernetes'], retrievalKeywords=['aws']
        // The resume text contains 'aws' — expect AWS/aws covered, Kubernetes missing
        const coverage = atsCheck.jdKeywordCoverage;
        const coveredTerms = coverage.filter((e) => e.present).map((e) => e.term);
        const missingTerms = coverage.filter((e) => !e.present).map((e) => e.term);
        expect(coveredTerms.length).toBeGreaterThan(0);
        expect(missingTerms).toContain('Kubernetes');
    });

    it('still persists meta/status/complete even when persistResume returns null (schema failure)', async () => {
        const calls: string[] = [];

        const deps = {
            extractJdSignal: jest.fn(async () => ({
                requiredSkills: [], preferredSkills: [], tools: [], concepts: [],
                responsibilities: [], domain: '', seniority: '', retrievalKeywords: [],
                companyProblem: '', targetRole: '', dimensionMix: { customerFacing: 0, technical: 0, aiMl: 0, supportOps: 0, monitoring: 0 },
                hardRequirements: [], softRequirements: [], implicitRequirements: [],
                technologyInventory: { languages: [], frameworks: [], infrastructure: [], tools: [], methodologies: [] },
                experienceSignals:   { yearsExpected: '', domainExperience: '', leadershipExpectation: '', scaleIndicators: '' },
            })) as never,
            gather: jest.fn(async () => ({
                kbPassages: [], projectEvidence: '', extractedTech: '', careerFacts: '', educationFacts: '',
            })) as never,
            writer: {
                invoke: jest.fn(async () => ({
                    resume: {
                        profile: { name: '', title: '', email: '', location: '' },
                        summary: '', experience: [], skills: [], education: [],
                        certifications: [], projects: [], keyAchievements: [],
                    },
                    coverLetter: { greeting: '', paragraphs: [], signoff: { name: '', email: '', linkedin: '', github: '' } },
                })) as never,
            },
            aliasMap:      jest.fn(async () => new Map<string, string>()) as never,
            persistResume: jest.fn(async () => { calls.push('resume'); return null; }) as never,
            persistMeta:   jest.fn(async () => { calls.push('meta'); }) as never,
            setStatus:     jest.fn(async () => { calls.push('status'); }) as never,
            complete:      jest.fn(async () => { calls.push('complete'); }) as never,
        };

        await runFreeTier({} as never, {
            userId: 'u', applicationId: 'a', pipelineId: 'p', pipelineRunId: 'pr',
            targetRole: '', targetCompany: '', jobDescription: '',
        } as never, deps as never);

        expect(calls).toEqual(['resume', 'meta', 'status', 'complete']);
    });
});
