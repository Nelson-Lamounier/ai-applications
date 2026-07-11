/** @format */
import type { Pool } from 'pg';
import type { PartialMatch, SkillGap } from '@bedrock/shared';
import {
    applyCorrectiveRetrieval, correctiveQuery,
    MAX_CORRECTIVE_GAPS,
    type CorrectiveCandidate, type CorrectiveVerdict,
} from './corrective-retrieval.js';

const gap = (skill: string, impactSeverity = 'minor', gapType = 'soft'): SkillGap => ({
    skill,
    gapType: gapType as SkillGap['gapType'],
    impactSeverity: impactSeverity as SkillGap['impactSeverity'],
    disqualifyingAssessment: `No ${skill} evidence in KB.`,
});

/** Pool stub whose tsv classifier marks the given skills as present. */
const poolWithPresent = (present: string[]): Pool => ({
    query: jest.fn(async (_sql: string, params: unknown[]) => ({
        rows: (params[1] as string[]).map((skill) => ({ skill, present: present.includes(skill) })),
    })),
}) as unknown as Pool;

const matchingOf = (gaps: SkillGap[], partialMatches: PartialMatch[] = []) => ({ gaps, partialMatches });

describe('applyCorrectiveRetrieval', () => {
    it('re-queries ONLY kb_present_not_retrieved gaps and promotes on a promote verdict', async () => {
        const retrieve = jest.fn(async () => ['[Source: o/r/file.ts, Cosine: 0.5]\nreal LangChain usage']);
        const adjudicate = jest.fn(async (cands: readonly CorrectiveCandidate[]): Promise<CorrectiveVerdict[]> =>
            cands.map((c) => ({
                skill: c.gap.skill,
                verdict: 'promote',
                evidenceSummary: 'Used in production agent loop.',
                framingSuggestion: 'Cite the agent loop.',
                evidenceFiles: ['o/r/file.ts'],
            })));

        const { matching, stats } = await applyCorrectiveRetrieval(
            matchingOf([gap('LangChain'), gap('Salesforce platform', 'blocking', 'hard')]),
            { pool: poolWithPresent(['LangChain']), userId: 'u1', retrieve, adjudicate },
        );

        // Only the present-not-retrieved gap was re-queried.
        expect(retrieve).toHaveBeenCalledTimes(1);
        expect(retrieve).toHaveBeenCalledWith(correctiveQuery('LangChain'), expect.any(Number));
        // Promotion moved the gap into partialMatches with the cited evidence.
        expect(matching.gaps.map((g) => g.skill)).toEqual(['Salesforce platform']);
        expect(matching.partialMatches).toHaveLength(1);
        expect(matching.partialMatches[0]).toMatchObject({ skill: 'LangChain', evidenceFiles: ['o/r/file.ts'] });
        expect(stats).toMatchObject({ candidates: 1, retrieved: 1, promoted: 1, promotedSkills: ['LangChain'] });
    });

    it('keeps the gap when the adjudicator answers stand (lexical-mention noise)', async () => {
        const retrieve = jest.fn(async () => ['[Source: o/r/comparison.md]\nSnowflake vs BigQuery table']);
        const adjudicate = jest.fn(async (cands: readonly CorrectiveCandidate[]): Promise<CorrectiveVerdict[]> =>
            cands.map((c) => ({ skill: c.gap.skill, verdict: 'stand' })));

        const { matching, stats } = await applyCorrectiveRetrieval(
            matchingOf([gap('Snowflake')]),
            { pool: poolWithPresent(['Snowflake']), userId: 'u1', retrieve, adjudicate },
        );

        expect(matching.gaps.map((g) => g.skill)).toEqual(['Snowflake']);
        expect(matching.partialMatches).toHaveLength(0);
        expect(stats).toMatchObject({ candidates: 1, retrieved: 1, promoted: 0 });
    });

    it('caps re-queries at MAX_CORRECTIVE_GAPS, severity-first', async () => {
        const gaps = [
            gap('a', 'minor'), gap('b', 'minor'), gap('c', 'significant'),
            gap('d', 'blocking'), gap('e', 'minor'), gap('f', 'significant'), gap('g', 'minor'),
        ];
        const retrieve = jest.fn(async (_query: string, _maxPassages: number) => [] as string[]);
        const adjudicate = jest.fn(async () => [] as CorrectiveVerdict[]);

        const { stats } = await applyCorrectiveRetrieval(
            matchingOf(gaps),
            { pool: poolWithPresent(gaps.map((g) => g.skill)), userId: 'u1', retrieve, adjudicate },
        );

        expect(retrieve).toHaveBeenCalledTimes(MAX_CORRECTIVE_GAPS);
        // Severity-ordered: blocking + both significants re-queried before minors.
        const queried = retrieve.mock.calls.map((c) => c[0]);
        expect(queried[0]).toBe(correctiveQuery('d'));
        expect(queried.slice(1, 3).sort()).toEqual([correctiveQuery('c'), correctiveQuery('f')].sort());
        expect(stats.candidates).toBe(MAX_CORRECTIVE_GAPS);
    });

    it('short-circuits without an adjudicator call when nothing re-retrieves', async () => {
        const retrieve = jest.fn(async () => [] as string[]);
        const adjudicate = jest.fn(async () => [] as CorrectiveVerdict[]);

        const { matching, stats } = await applyCorrectiveRetrieval(
            matchingOf([gap('Cursor')]),
            { pool: poolWithPresent(['Cursor']), userId: 'u1', retrieve, adjudicate },
        );

        expect(adjudicate).not.toHaveBeenCalled();
        expect(matching.gaps).toHaveLength(1);
        expect(stats).toMatchObject({ candidates: 1, retrieved: 0, promoted: 0 });
    });

    it('is a no-op when no gap is classified present_not_retrieved', async () => {
        const retrieve = jest.fn(async () => [] as string[]);
        const adjudicate = jest.fn(async () => [] as CorrectiveVerdict[]);

        const input = matchingOf([gap('Agentforce', 'significant', 'hard')]);
        const { matching, stats } = await applyCorrectiveRetrieval(
            input,
            { pool: poolWithPresent([]), userId: 'u1', retrieve, adjudicate },
        );

        expect(retrieve).not.toHaveBeenCalled();
        expect(matching).toBe(input); // untouched object, not a copy
        expect(stats).toMatchObject({ candidates: 0, retrieved: 0, promoted: 0 });
    });
});
