/** @format */
import type { StructuredResumeData } from '@bedrock/shared';

import { gradeResumeAts } from './ats-grader.js';

const GOOD: StructuredResumeData = {
    profile: { name: 'Jane Doe', title: 'Platform Engineer', email: 'jane@example.com', location: 'Berlin' },
    summary: 'Platform engineer.',
    experience: [{ company: 'Acme', title: 'SRE', period: '2022–2026', highlights: ['Ran Kubernetes on AWS.'] }],
    skills: [{ category: 'Infra', skills: ['Kubernetes', 'AWS'] }],
    education: [{ degree: 'BSc CS', institution: 'TU Berlin', period: '2014–2018' }],
    certifications: [], projects: [], keyAchievements: [],
};

describe('gradeResumeAts', () => {
    it('passes a clean resume with grounded JD must-haves present', async () => {
        const res = await gradeResumeAts(GOOD, { jdMustHaves: ['Kubernetes'], groundedTerms: new Set(['kubernetes']) });
        expect(res.pass).toBe(true);
        expect(res.score).toBe(1);
        expect(res.failures).toEqual([]);
    });
});
