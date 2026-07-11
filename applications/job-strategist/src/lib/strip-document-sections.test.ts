/** @format */
import { stripDocumentSections } from './strip-document-sections.js';

describe('stripDocumentSections — grounding-verifier input trim', () => {
	it('replaces the resume JSON and cover letter CDATA with omission markers', () => {
		const xml = [
			'<phase_1_jd_analysis>real analysis prose</phase_1_jd_analysis>',
			'<tailored_resume_json><![CDATA[{"experience":[{"company":"X","numbers":"120ms"}]}]]></tailored_resume_json>',
			'<cover_letter><![CDATA[Dear team, I built things.]]></cover_letter>',
		].join('\n');
		const out = stripDocumentSections(xml);
		expect(out).toContain('real analysis prose');
		expect(out).not.toContain('120ms');
		expect(out).not.toContain('Dear team');
		expect(out).toContain('separately-guarded');
	});

	it('is a no-op when the sections are absent', () => {
		const xml = '<phase_2_gap_analysis>gaps</phase_2_gap_analysis>';
		expect(stripDocumentSections(xml)).toBe(xml);
	});
});
