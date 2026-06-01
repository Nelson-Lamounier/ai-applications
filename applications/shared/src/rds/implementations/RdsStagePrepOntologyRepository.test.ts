/** @format */
import { describe, it, expect, jest } from '@jest/globals';
import { RdsStagePrepOntologyRepository } from './RdsStagePrepOntologyRepository.js';

// Sequential fake: returns queued result sets in call order (for fallback testing).
function seqPool(resultSets: unknown[][]) {
    let i = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const query = jest.fn(async () => ({ rows: resultSets[i++] ?? [] }));
    return { pool: { query } as any, query };
}

const EXP_ROW = {
    id: '*|*|phone-screen', company_type: '*', role_family: '*', stage: 'phone-screen',
    focus_areas: ['career arc'], question_patterns: [{ type: 'career-arc', prompt_hint: 'h' }],
    expectation_note: 'note',
};

describe('RdsStagePrepOntologyRepository.getStageExpectation', () => {
    it('returns the exact match on the first query', async () => {
        const { pool, query } = seqPool([[EXP_ROW]]);
        const repo = new RdsStagePrepOntologyRepository(pool);
        const e = await repo.getStageExpectation('faang', 'backend', 'phone-screen');
        expect(e?.questionPatterns[0]).toEqual({ type: 'career-arc', promptHint: 'h' });
        expect(query).toHaveBeenCalledTimes(1); // exact hit, no fallback
    });
    it('falls back to ("*", role, stage) then ("*","*",stage)', async () => {
        const { pool, query } = seqPool([[], [], [EXP_ROW]]); // exact miss, role-only miss, generic hit
        const repo = new RdsStagePrepOntologyRepository(pool);
        const e = await repo.getStageExpectation('faang', 'backend', 'phone-screen');
        expect(e?.stage).toBe('phone-screen');
        expect(query).toHaveBeenCalledTimes(3);
    });
    it('returns null when every tier misses', async () => {
        const { pool } = seqPool([[], [], []]);
        const repo = new RdsStagePrepOntologyRepository(pool);
        expect(await repo.getStageExpectation('faang', 'backend', 'offer')).toBeNull();
    });
});

describe('RdsStagePrepOntologyRepository.getCompBenchmark', () => {
    it('returns an exact role-specific match on the first query', async () => {
        const { pool, query } = seqPool([[{
            id: 'backend|mid|us', role_family: 'backend', seniority: 'mid',
            region: 'us', currency: 'USD', range_min: 175000, range_p50: 175000, range_max: 175000,
        }]]);
        const repo = new RdsStagePrepOntologyRepository(pool);
        const c = await repo.getCompBenchmark('backend', 'mid', 'us');
        expect(c?.rangeP50).toBe(175000);
        expect(c?.currency).toBe('USD');
        expect(query).toHaveBeenCalledTimes(1); // exact hit, no fallback
    });
    it('falls back to role_family "*" when no role-specific row exists', async () => {
        const { pool, query } = seqPool([[], [{
            id: '*|senior|uk', role_family: '*', seniority: 'senior',
            region: 'uk', currency: 'GBP', range_min: 86057, range_p50: 114206, range_max: 161094,
        }]]); // exact miss, generic hit
        const repo = new RdsStagePrepOntologyRepository(pool);
        const c = await repo.getCompBenchmark('backend', 'senior', 'uk');
        expect(c?.roleFamily).toBe('*');
        expect(c?.rangeP50).toBe(114206);
        expect(query).toHaveBeenCalledTimes(2);
    });
    it('does not double-query when role_family is already "*"', async () => {
        const { pool, query } = seqPool([[]]);
        const repo = new RdsStagePrepOntologyRepository(pool);
        expect(await repo.getCompBenchmark('*', 'senior', 'us')).toBeNull();
        expect(query).toHaveBeenCalledTimes(1);
    });
});

describe('RdsStagePrepOntologyRepository.listScaffolds', () => {
    it('maps scaffold rows of a kind', async () => {
        const { pool } = seqPool([[
            { id: 'gap-adjacent-pivot', kind: 'gap_handling', title: 'T', structure: { trigger: 'x' } },
        ]]);
        const repo = new RdsStagePrepOntologyRepository(pool);
        const s = await repo.listScaffolds('gap_handling');
        expect(s[0]).toEqual({ id: 'gap-adjacent-pivot', kind: 'gap_handling', title: 'T', structure: { trigger: 'x' } });
    });
});

describe('RdsStagePrepOntologyRepository.getCompanyProfile', () => {
    it('maps a profile row snake_case -> camelCase', async () => {
        const { pool } = seqPool([[{
            company_key: 'amazon', display_name: 'Amazon', company_type: 'faang',
            leadership_principles: [{ name: 'Ownership', description: 'd' }],
            process_shape: [{ stage: 'phone-screen', format: 'recruiter screen', note: 'n' }],
            values_taxonomy: [],
        }]]);
        const repo = new RdsStagePrepOntologyRepository(pool);
        const p = await repo.getCompanyProfile('amazon');
        expect(p?.companyKey).toBe('amazon');
        expect(p?.displayName).toBe('Amazon');
        expect(p?.leadershipPrinciples[0]).toEqual({ name: 'Ownership', description: 'd' });
        expect(p?.processShape[0].stage).toBe('phone-screen');
    });
    it('returns null when the company is unknown', async () => {
        const { pool } = seqPool([[]]);
        const repo = new RdsStagePrepOntologyRepository(pool);
        expect(await repo.getCompanyProfile('nope')).toBeNull();
    });
});
