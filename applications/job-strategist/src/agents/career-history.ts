/** @format */
import type { Pool } from 'pg';

export interface CareerEntry {
    readonly title: string;
    readonly company: string;
    readonly period: string;
    readonly highlights: string[];
}

interface CareerRow { raw_data: { title?: string; company?: string; period?: string; highlights?: string[] } | null }

/**
 * Load the user's experience entries from user_career_history (résumé Career Data).
 * Any enrichment_status — structured evidence, available pre-confirmation.
 */
export async function loadCareerHistory(pool: Pool, userId: string, limit = 8): Promise<CareerEntry[]> {
    const r = await pool.query<CareerRow>(
        `SELECT raw_data FROM user_career_history
          WHERE user_id = $1::uuid AND entry_type = 'experience'
          ORDER BY display_order ASC
          LIMIT $2`,
        [userId, limit],
    );
    return r.rows.map(row => ({
        title:      row.raw_data?.title ?? '',
        company:    row.raw_data?.company ?? '',
        period:     row.raw_data?.period ?? '',
        highlights: row.raw_data?.highlights ?? [],
    })).filter(e => e.title || e.company);
}

/**
 * Render career entries as a citeable evidence section for the Research prompt.
 * Distinct from the résumé "formatting reference only" path — this IS evidence
 * the model may cite. Empty string when there are no entries.
 */
export function formatCareerHistory(entries: CareerEntry[]): string {
    if (entries.length === 0) return '';
    const lines = ['## Career History (verified from your résumé — citeable evidence)'];
    for (const e of entries) {
        lines.push(`- **${e.title}** at ${e.company} (${e.period})`);
        for (const h of e.highlights) lines.push(`    - ${h}`);
    }
    return lines.join('\n');
}
