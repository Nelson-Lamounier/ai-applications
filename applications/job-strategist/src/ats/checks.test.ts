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
