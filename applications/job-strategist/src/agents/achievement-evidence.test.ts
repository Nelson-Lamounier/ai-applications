/** @format */
import { loadAchievementEvidence } from './achievement-evidence.js';

function makePool(rows: { challenges?: unknown[]; decisions?: unknown[]; highlights?: unknown[] }) {
	return {
		query: async (sql: string) => {
			if (/FROM project_challenges/.test(sql)) return { rows: rows.challenges ?? [] };
			if (/FROM project_decisions/.test(sql)) return { rows: rows.decisions ?? [] };
			if (/FROM project_highlights/.test(sql)) return { rows: rows.highlights ?? [] };
			return { rows: [] };
		},
	} as never;
}

describe('loadAchievementEvidence', () => {
	it('formats challenges, decision-impacts and achievements into labelled groups', async () => {
		const out = await loadAchievementEvidence(
			makePool({
				challenges: [
					{
						problem: 'bedrock:Rerank failed silently',
						solution: 'traced via simulate-principal-policy, shipped CDK fix',
					},
				],
				decisions: [
					{
						decision: 'Migrate edge to EKS ALB, retire CloudFront',
						consequences: 'cut an edge layer and its failure surface',
					},
				],
				highlights: [
					{
						title: 'Controlled-vocabulary enrichment',
						description: 'skills overlap lifted from 2.2% to full operation',
					},
				],
			}),
			'u1',
		);
		expect(out).toContain('Challenges overcome');
		expect(out).toContain('bedrock:Rerank failed silently -> traced via simulate-principal-policy');
		expect(out).toContain('Decision impact');
		expect(out).toContain('Migrate edge to EKS ALB, retire CloudFront -> cut an edge layer');
		expect(out).toContain('Achievements');
		expect(out).toContain('Controlled-vocabulary enrichment — skills overlap lifted');
	});
	it('returns empty string when nothing is populated (fail-open)', async () => {
		expect(await loadAchievementEvidence(makePool({}), 'u1')).toBe('');
	});
	it('returns empty string when a query throws', async () => {
		const pool = { query: async () => { throw new Error('db down'); } } as never;
		expect(await loadAchievementEvidence(pool, 'u1')).toBe('');
	});
});
