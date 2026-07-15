/** @format */
import type { Pool } from 'pg';
import type { SkillGap } from '@bedrock/shared';
import { classifyGapCauses, annotateGapCauses } from '../gap-cause.js';

const gap = (skill: string): SkillGap => ({
    skill, gapType: 'hard', impactSeverity: 'significant', disqualifyingAssessment: 'x',
} as SkillGap);

function poolWithPresence(present: Record<string, boolean>): Pool {
    return {
        query: jest.fn().mockImplementation((_sql: string, params: unknown[]) => {
            const skills = params[1] as string[];
            return Promise.resolve({ rows: skills.map((s) => ({ skill: s, present: present[s] ?? false })) });
        }),
    } as unknown as Pool;
}

describe('classifyGapCauses', () => {
    it('maps present skills to kb_present_not_retrieved and absent ones to kb_no_evidence', async () => {
        const pool = poolWithPresence({ Kubernetes: true, LangGraph: false });
        const causes = await classifyGapCauses(pool, 'u1', ['Kubernetes', 'LangGraph']);
        expect(causes.get('Kubernetes')).toBe('kb_present_not_retrieved');
        expect(causes.get('LangGraph')).toBe('kb_no_evidence');
    });

    it('empty skill list → no query, empty map', async () => {
        const pool = { query: jest.fn() } as unknown as Pool;
        const causes = await classifyGapCauses(pool, 'u1', []);
        expect(causes.size).toBe(0);
        expect((pool as unknown as { query: jest.Mock }).query).not.toHaveBeenCalled();
    });

    it('scopes tsv presence to evidence lanes: config/data hits are excluded, unstamped chunks fail open', async () => {
        const pool = poolWithPresence({ Angular: true });
        await classifyGapCauses(pool, 'u1', ['Angular']);
        const [sql, params] = (pool as unknown as { query: jest.Mock }).query.mock.calls[0] as [string, unknown[]];
        // The lexical check must not count noise lanes (a skill name in a config
        // value or data fixture is not practised evidence)…
        expect(sql).toMatch(/COALESCE\(de\.metadata->>'fileClass', ''\) <> ALL\(\$3::text\[\]\)/);
        expect(params[2]).toEqual(['config', 'data']);
        // …while COALESCE('') keeps unstamped (pre-restamp) chunks counting.
        expect(sql).toContain("COALESCE(de.metadata->>'fileClass', '')");
    });
});

describe('annotateGapCauses', () => {
    it('annotates every gap and reports each cause to the callback', async () => {
        const pool = poolWithPresence({ GCP: false, 'Vector databases': true });
        const seen: string[] = [];
        const out = await annotateGapCauses(pool, 'u1', [gap('GCP'), gap('Vector databases')], (c) => seen.push(c));
        expect(out.map((g) => g.gapCause)).toEqual(['kb_no_evidence', 'kb_present_not_retrieved']);
        expect(seen.sort()).toEqual(['kb_no_evidence', 'kb_present_not_retrieved']);
    });

    it('propagates the query error so callers can fail open', async () => {
        const pool = { query: jest.fn().mockRejectedValue(new Error('db down')) } as unknown as Pool;
        await expect(annotateGapCauses(pool, 'u1', [gap('GCP')])).rejects.toThrow('db down');
    });
});
