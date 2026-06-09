import { describe, it, expect } from '@jest/globals';
import { extractResumeProseSections } from './resume-prose.js';
import type { StructuredResumeData } from '@bedrock/shared';

const RESUME = {
    profile: { name: 'X', title: 'Eng', email: 'x@y.z', location: 'Dublin' },
    summary: 'A results-driven engineer who leverages cutting-edge tools.',
    experience: [{ company: 'AWS', title: 'TSA', period: '2022', highlights: ['Debugged IAM policies end-to-end.'] }],
    skills: [],
    education: [],
    certifications: [],
    projects: [{ name: 'Tucaken', description: 'A multi-agent platform.', github: 'gh' }],
    keyAchievements: [{ achievement: 'Cut MTTR 40%.' }],
} as unknown as StructuredResumeData;

describe('extractResumeProseSections', () => {
    it('extracts summary, highlights, achievements, projects, and cover letter', () => {
        const out = extractResumeProseSections(RESUME, 'Dear hiring team, I am writing to express interest.');
        const locs = out.map(s => s.location);
        expect(locs).toContain('coverLetter');
        expect(locs).toContain('resume.summary');
        expect(locs).toContain('resume.experience[0].highlights[0]');
        expect(locs).toContain('resume.keyAchievements[0]');
        expect(locs).toContain('resume.projects[0].description');
        expect(out.every(s => s.text.length > 0)).toBe(true);
    });

    it('skips empty / missing surfaces', () => {
        expect(extractResumeProseSections(null, null)).toEqual([]);
        expect(extractResumeProseSections(null, '   ')).toEqual([]);
    });

    it('tags cover letter as narrative and resume bullets as resume-prose', () => {
        const out = extractResumeProseSections(RESUME, 'A cover letter.');
        expect(out.find(s => s.location === 'coverLetter')?.register).toBe('narrative');
        expect(out.find(s => s.location === 'resume.summary')?.register).toBe('resume-prose');
    });
});
