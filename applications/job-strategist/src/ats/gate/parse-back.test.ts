/** @format */
import type { StructuredResumeData } from '@bedrock/shared';

import { renderResumePdf } from '../../render/render-resume-pdf.js';
import { parsePdfBack } from './parse-back.js';

const SAMPLE: StructuredResumeData = {
    profile: { name: 'Jane Doe', title: 'Platform Engineer', email: 'jane@example.com', location: 'Berlin, DE' },
    summary: 'Platform engineer.',
    experience: [{ company: 'Acme', title: 'SRE', period: '2022–2026', highlights: ['Ran EKS.'] }],
    skills: [{ category: 'Infra', skills: ['Kubernetes'] }],
    education: [{ degree: 'BSc CS', institution: 'TU Berlin', period: '2014–2018' }],
    certifications: [], projects: [], keyAchievements: [],
};

describe('parsePdfBack', () => {
    it('extracts selectable text and detects standard sections', async () => {
        const buf = await renderResumePdf(SAMPLE);
        const { text, sections } = await parsePdfBack(buf);
        expect(text).toContain('Jane Doe');
        expect(text).toContain('jane@example.com');
        expect(sections).toEqual(expect.arrayContaining(['Experience', 'Skills', 'Education']));
    });
});
