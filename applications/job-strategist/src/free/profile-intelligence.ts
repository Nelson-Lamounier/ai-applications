/**
 * @format
 * Free-tier positioning signal — the candidate's code-grounded per-area
 * seniority from user_profile_rollup.direction (pure DB read, no LLM). A
 * POSITIONING aid only: it shapes how the writer frames the candidate's
 * identity; it is NEVER a source for fabricated metrics. Fail-open to ''.
 */
import type { Pool } from 'pg';

const AREA_CAP = 4;

interface Seniority { area: string; level: string; evidence?: string }

export async function loadProfilePositioning(pool: Pool, userId: string): Promise<string> {
    try {
        const row = (await pool.query<{ direction: { seniority?: Seniority[] } | null }>(
            `SELECT direction FROM user_profile_rollup WHERE user_id = $1`,
            [userId],
        )).rows[0];
        const seniority = row?.direction?.seniority ?? [];
        if (seniority.length === 0) return '';

        const lines = ['Positioning signal (code-grounded seniority — use to FRAME the candidate, not to invent metrics):'];
        for (const s of seniority.slice(0, AREA_CAP)) {
            const ev = s.evidence ? ` — ${s.evidence.split('\n')[0].slice(0, 240)}` : '';
            lines.push(`- ${s.area}: ${s.level}${ev}`);
        }
        return lines.join('\n');
    } catch {
        return '';
    }
}
