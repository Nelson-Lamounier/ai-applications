/** @format */
import { preserveResumeFields } from '../preserve-resume-fields.js';
import type { StructuredResumeData } from '@bedrock/shared';

const original = {
	summary: 's',
	projects: [
		{ name: 'tucaken', description: 'd', github: 'github.com/x/tucaken-infra' },
		{ name: 'portfolio', description: 'd2', github: 'github.com/x/frontend-portfolio' },
	],
	sectionOrder: ['summary', 'projects'],
} as unknown as StructuredResumeData;

describe('preserveResumeFields — lossy rewrite round-trips', () => {
	it('restores projects[].github dropped by a rewrite tool schema (observed live)', () => {
		const rewritten = {
			summary: 's2',
			projects: [
				{ name: 'tucaken', description: 'rewritten' },
				{ name: 'portfolio', description: 'rewritten2' },
			],
			sectionOrder: ['summary', 'projects'],
		} as unknown as StructuredResumeData;
		const out = preserveResumeFields(original, rewritten) as unknown as { projects: Array<{ github?: string }> };
		expect(out.projects[0].github).toBe('github.com/x/tucaken-infra');
		expect(out.projects[1].github).toBe('github.com/x/frontend-portfolio');
	});

	it('restores top-level keys the rewrite dropped, without touching rewritten content', () => {
		const rewritten = { summary: 's2', projects: [] } as unknown as StructuredResumeData;
		const out = preserveResumeFields(original, rewritten) as unknown as { sectionOrder?: string[]; summary: string };
		expect(out.sectionOrder).toEqual(['summary', 'projects']);
		expect(out.summary).toBe('s2');
	});

	it('is a no-op with a null original', () => {
		const rewritten = { summary: 's2' } as unknown as StructuredResumeData;
		expect(preserveResumeFields(null, rewritten)).toBe(rewritten);
	});
});
