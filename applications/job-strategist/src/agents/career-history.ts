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

export interface EducationEntry {
    readonly degree: string;
    readonly institution: string;
    readonly period: string;
}

interface EducationRow { raw_data: { degree?: string; institution?: string; period?: string } | null }

/**
 * Load the user's education entries from user_career_history (extracted verbatim
 * from their résumé). These are FACTUAL — the generator must reproduce the degree
 * name and institution exactly, never invent them.
 */
export async function loadEducation(pool: Pool, userId: string, limit = 8): Promise<EducationEntry[]> {
    const r = await pool.query<EducationRow>(
        `SELECT raw_data FROM user_career_history
          WHERE user_id = $1::uuid AND entry_type = 'education'
          ORDER BY display_order ASC
          LIMIT $2`,
        [userId, limit],
    );
    return r.rows.map(row => ({
        degree:      row.raw_data?.degree ?? '',
        institution: row.raw_data?.institution ?? '',
        period:      row.raw_data?.period ?? '',
    })).filter(e => e.degree || e.institution);
}

/**
 * Render education as a strict, verbatim factual block. The degree name and
 * institution are exact strings from the user's résumé — the generator MUST NOT
 * alter, abbreviate, or substitute them (prevents hallucinated institutions).
 */
export function formatEducation(entries: EducationEntry[]): string {
    if (entries.length === 0) return '';
    const lines = [
        'VERIFIED EDUCATION (FACTUAL — reproduce the degree name and institution VERBATIM;',
        'never invent, abbreviate, or substitute an institution):',
    ];
    for (const e of entries) {
        const parts = [e.degree, e.institution].filter(Boolean).join(' — ');
        lines.push(`- ${parts}${e.period ? ` (${e.period})` : ''}`);
    }
    return lines.join('\n');
}
