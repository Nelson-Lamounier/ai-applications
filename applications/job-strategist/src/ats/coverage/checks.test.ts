/** @format */
import { buildAtsCheck } from './checks.js';

const TEXT = [
    'Jane Doe', 'Platform Engineer', 'jane@example.com',
    'Experience', 'SRE — Acme', 'Ran Kubernetes on AWS.',
    'Skills', 'Infra: Kubernetes, AWS',
    'Education', 'BSc CS, TU Berlin',
].join('\n');

describe('buildAtsCheck', () => {
    it('passes a clean machine-readable resume when pre-built coverage is provided', () => {
        const r = buildAtsCheck({
            text: TEXT,
            sections: ['Experience', 'Skills', 'Education'],
            profile: { name: 'Jane Doe', email: 'jane@example.com' },
            coverage: [
                { term: 'Kubernetes', present: true, grounded: true, tier: 'literal' },
                { term: 'AWS',        present: true, grounded: true, tier: 'literal' },
            ],
        });
        expect(r.machineReadable).toBe(true);
        expect(r.parseBreakers).toEqual([]);
        expect(r.passed).toBe(true);
        expect(r.status).toBe('passed');
        expect(r.jdKeywordCoverage).toEqual(expect.arrayContaining([
            { term: 'Kubernetes', present: true, grounded: true, tier: 'literal' },
            { term: 'AWS',        present: true, grounded: true, tier: 'literal' },
        ]));
    });

    it('reports tier "none" for absent terms passed in pre-built coverage', () => {
        const r = buildAtsCheck({
            text: TEXT,
            sections: ['Experience', 'Skills', 'Education'],
            profile: { name: 'Jane Doe', email: 'jane@example.com' },
            coverage: [
                { term: 'Kubernetes', present: true,  grounded: true,  tier: 'normalized' },
                { term: 'ChatGPT',    present: false, grounded: false, tier: 'none' },
            ],
        });
        const chatGpt = r.jdKeywordCoverage.find((c) => c.term === 'ChatGPT');
        expect(chatGpt?.present).toBe(false);
        expect(chatGpt?.tier).toBe('none');
    });

    it('falls back to legacy literal match when coverage is not provided', () => {
        const r = buildAtsCheck({
            text: TEXT,
            sections: ['Experience', 'Skills', 'Education'],
            profile: { name: 'Jane Doe', email: 'jane@example.com' },
            jdMustHaves: ['Kubernetes', 'AWS'],
            groundedTerms: new Set(['kubernetes', 'aws']),
        });
        expect(r.passed).toBe(true);
        expect(r.jdKeywordCoverage).toEqual(expect.arrayContaining([
            { term: 'Kubernetes', present: true, grounded: true, tier: 'literal' },
            { term: 'AWS', present: true, grounded: true, tier: 'literal' },
        ]));
    });

    it('flags issues when a required section is missing', () => {
        const r = buildAtsCheck({
            text: 'Jane Doe\njane@example.com\nExperience\nSRE',
            sections: ['Experience'],
            profile: { name: 'Jane Doe', email: 'jane@example.com' },
            coverage: [],
        });
        expect(r.passed).toBe(false);
        expect(r.status).toBe('issues');
        expect(r.issues.join(' ')).toMatch(/Education|Skills/);
    });

    it('returns unverified when text extraction produced nothing', () => {
        const r = buildAtsCheck({
            text: '', sections: [], profile: { name: 'Jane Doe', email: 'jane@example.com' },
            coverage: [],
        });
        expect(r.machineReadable).toBe(false);
        expect(r.status).toBe('unverified');
        expect(r.passed).toBe(false);
    });
});

describe('buildAtsCheck — weighted coverage score', () => {
	const base = {
		text: 'Nelson Lamounier nelson@example.com Summary Experience Skills Projects Education Certifications',
		sections: ['Summary', 'Experience', 'Skills', 'Projects', 'Education', 'Certifications'],
		pages: 2,
		profile: { name: 'Nelson Lamounier', email: 'nelson@example.com' },
	};
	const row = (term: string, present: boolean) => ({ term, present, grounded: true, tier: present ? 'literal' as const : 'none' as const });

	it('weights required terms 0.7 and the rest 0.3 (evidence-fit convention)', () => {
		const check = buildAtsCheck({
			...base,
			coverage: [row('Docker', true), row('Kubernetes', false), row('Datadog', true), row('Grafana', true)],
			requiredSkills: ['Docker', 'Kubernetes'],
		});
		// required: 1/2, rest: 2/2 -> 0.7*0.5 + 0.3*1 = 0.65
		expect(check.coverageScore).toBeCloseTo(0.65, 5);
	});

	it('renormalises when the JD names no required skills', () => {
		const check = buildAtsCheck({
			...base,
			coverage: [row('Datadog', true), row('Grafana', false)],
			requiredSkills: [],
		});
		expect(check.coverageScore).toBeCloseTo(0.5, 5);
	});

	it('omits the score when there is no coverage at all', () => {
		const check = buildAtsCheck({ ...base, coverage: [], requiredSkills: [] });
		expect(check.coverageScore).toBeUndefined();
	});
});
