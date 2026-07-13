/** @format */
import { describe, it, expect } from '@jest/globals';
import { groundedAtsCoverage } from './grounded-coverage.js';

const alias = new Map<string, string>([
	['k8s', 'kubernetes'],
	['kubernetes', 'kubernetes'],
	['aws', 'aws'],
]);

describe('groundedAtsCoverage', () => {
	it('counts a JD keyword as covered when a synonym appears in the resume (k8s ≡ Kubernetes)', () => {
		const r = groundedAtsCoverage('Built a Kubernetes platform on AWS.', ['k8s', 'AWS', 'Terraform'], alias);
		expect(r.covered.sort()).toEqual(['AWS', 'k8s']);
		expect(r.missing).toEqual(['Terraform']);
		expect(r.coverageRate).toBeCloseTo(2 / 3);
	});

	it('falls back to case-insensitive exact match when no alias maps the term', () => {
		const r = groundedAtsCoverage('Used GraphQL extensively.', ['graphql'], new Map());
		expect(r.covered).toEqual(['graphql']);
	});

	it('is empty-safe (no keywords → rate 1, nothing missing)', () => {
		const r = groundedAtsCoverage('anything', [], new Map());
		expect(r).toEqual({ covered: [], missing: [], coverageRate: 1 });
	});

	it('strips sentence-final punctuation so "AWS." is covered by keyword "aws"', () => {
		const r = groundedAtsCoverage('We use AWS.', ['aws'], new Map([['aws', 'aws']]));
		expect(r.covered).toEqual(['aws']);
		expect(r.missing).toEqual([]);
	});
});
