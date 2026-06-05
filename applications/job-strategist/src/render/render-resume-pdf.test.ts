/** @format */
import type { StructuredResumeData } from '@bedrock/shared';

import { renderResumePdf } from './render-resume-pdf.js';

const SAMPLE: StructuredResumeData = {
    profile: { name: 'Jane Doe', title: 'Platform Engineer', email: 'jane@example.com', location: 'Berlin, DE' },
    summary: 'Platform engineer with Kubernetes and AWS experience.',
    experience: [{ company: 'Acme', title: 'SRE', period: '2022–2026', highlights: ['Ran 25 ArgoCD applications across EKS.'] }],
    skills: [{ category: 'Infra', skills: ['Kubernetes', 'AWS', 'Terraform'] }],
    education: [{ degree: 'BSc CS', institution: 'TU Berlin', period: '2014–2018' }],
    certifications: [],
    projects: [],
    keyAchievements: [],
};

describe('renderResumePdf', () => {
    it('produces a non-empty PDF buffer with a %PDF header', async () => {
        const buf = await renderResumePdf(SAMPLE);
        expect(buf.length).toBeGreaterThan(1000);
        expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    });
});
