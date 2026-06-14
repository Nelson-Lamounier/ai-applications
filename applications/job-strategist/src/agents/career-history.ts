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

/**
 * Render experience entries as a strict factual block for the resume generator.
 * Company, job title, and period are exact strings from the user's résumé — the
 * generator MUST reproduce them verbatim in the experience section and never
 * rename a role (e.g. never relabel "Technical Customer Service Associate" as
 * "Cloud Support Engineer"). Only bullet highlights may be tailored.
 */
export function formatExperienceFacts(entries: CareerEntry[]): string {
    if (entries.length === 0) return '';
    const lines = [
        'VERIFIED EXPERIENCE (FACTUAL — reproduce company, job title, and period VERBATIM;',
        'never rename or re-title a role. Repositioning belongs only in the profile headline +',
        'summary, never in an experience entry. Only the bullet highlights may be tailored):',
    ];
    for (const e of entries) {
        lines.push(`- ${e.title} — ${e.company} (${e.period})`);
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
        const suffix = e.period ? ` (${e.period})` : '';
        lines.push(`- ${parts}${suffix}`);
    }
    return lines.join('\n');
}

export interface CertificationEntry {
    readonly name: string;
    readonly issuer: string;
    readonly date: string;
}

interface CertificationRow { raw_data: { name?: string; issuer?: string; date?: string; period?: string } | null }

/**
 * Load the user's certifications from user_career_history (entry_type='certification').
 * Previously dropped entirely — the pipeline only loaded experience + education — so a
 * relevant professional cert (e.g. AWS Certified DevOps Engineer – Professional) was
 * invisible to the matcher. FACTUAL: reproduce the certification name verbatim.
 */
export async function loadCertifications(pool: Pool, userId: string, limit = 12): Promise<CertificationEntry[]> {
    const r = await pool.query<CertificationRow>(
        `SELECT raw_data FROM user_career_history
          WHERE user_id = $1::uuid AND entry_type = 'certification'
          ORDER BY display_order ASC
          LIMIT $2`,
        [userId, limit],
    );
    return r.rows.map(row => ({
        name:   row.raw_data?.name ?? '',
        issuer: row.raw_data?.issuer ?? '',
        date:   row.raw_data?.date ?? row.raw_data?.period ?? '',
    })).filter(e => e.name);
}

/**
 * Render certifications as a verbatim factual block AND instruct the matcher to weigh each
 * against the JD — a current, domain-relevant professional certification is strong
 * corroborating evidence for the related required skills, and must be cited where it
 * reinforces a match (not invented, not over-claimed into unrelated skills).
 */
export function formatCertifications(entries: CertificationEntry[]): string {
    if (entries.length === 0) return '';
    const lines = [
        'VERIFIED CERTIFICATIONS (FACTUAL — reproduce the certification name VERBATIM; never invent).',
        'WEIGH each against the JD: a current, domain-relevant professional certification is strong',
        'corroborating evidence for the related required skills — cite it where it reinforces a match',
        '(e.g. an AWS professional cert reinforces cloud troubleshooting, automation, and infra skills).',
        'Do NOT stretch a certification into unrelated skills.',
    ];
    for (const e of entries) {
        const parts = [e.name, e.issuer].filter(Boolean).join(' — ');
        const suffix = e.date ? ` (${e.date})` : '';
        lines.push(`- ${parts}${suffix}`);
    }
    return lines.join('\n');
}
