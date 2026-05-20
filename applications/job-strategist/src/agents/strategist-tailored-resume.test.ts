/**
 * @format
 * Strategist Agent — tailored_resume_json fail-fast extraction.
 *
 * Strategist keeps extended thinking (no forced tool_use); the tailored
 * resume JSON it embeds is structured data persisted by the Resume
 * Builder, so a present-but-malformed block must fail fast rather than
 * be silently dropped (structure-output-checklist §7).
 */

import type { extractTailoredResumeJson as ExtractTailoredResumeJsonFn } from './strategist-agent.js';

let extractTailoredResumeJson: typeof ExtractTailoredResumeJsonFn;

beforeAll(async () => {
    ({ extractTailoredResumeJson } = await import('./strategist-agent.js'));
});

const VALID_RESUME = {
    profile: { name: 'Nelson', title: 'SRE', email: 'n@example.com', location: 'Dublin' },
    summary: 'Experienced SRE.',
    experience: [{ company: 'Acme', title: 'SRE', period: '2020-2024', highlights: ['ran k8s'] }],
    skills: [{ category: 'Cloud', skills: ['AWS'] }],
    education: [{ degree: 'BSc', institution: 'TU', period: '2016-2020' }],
    certifications: [{ name: 'CKA', year: '2023', issuer: 'CNCF' }],
    projects: [{ name: 'self-healing', description: 'operator' }],
    keyAchievements: [{ achievement: 'cut MTTR 40%' }],
};

const wrap = (json: string) =>
    `<analysis><tailored_resume_json><![CDATA[${json}]]></tailored_resume_json></analysis>`;

describe('extractTailoredResumeJson', () => {
    it('returns null when the section is absent (legitimately optional)', () => {
        expect(extractTailoredResumeJson('<analysis>no resume here</analysis>')).toBeNull();
    });

    it('returns the validated resume when the block is well-formed', () => {
        const r = extractTailoredResumeJson(wrap(JSON.stringify(VALID_RESUME)));
        expect(r?.profile.name).toBe('Nelson');
        expect(r?.experience).toHaveLength(1);
    });

    it('throws fast when the block is present but not valid JSON', () => {
        expect(() => extractTailoredResumeJson(wrap('{ not json'))).toThrow();
    });

    it('throws fast when the block is present but fails schema validation', () => {
        const { profile: _profile, ...broken } = VALID_RESUME;
        expect(() => extractTailoredResumeJson(wrap(JSON.stringify(broken))))
            .toThrow(/schema validation/i);
    });
});
