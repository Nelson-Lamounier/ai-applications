/**
 * @format
 * Candidate contact — per-user identity for the resume profile and the
 * cover-letter signoff.
 *
 * Multi-tenant correctness: until 2026-07-09 the strategist persona's
 * cover-letter template carried one user's literal contact details as the
 * signoff example and nothing per-user reached the writer — any other
 * tenant's documents would have shipped with that identity. The persona now
 * carries placeholders and this module supplies the real values as a
 * labelled user-message section.
 *
 * Source order:
 *   1. the user's most recent resume row's profile (the contact they actually
 *      publish — covers both imported base resumes and generated ones);
 *   2. the auth identity (users.full_name/email) for a brand-new tenant;
 *   3. nothing — the section is omitted and the persona instructs the writer
 *      to leave contact fields empty, never to invent them.
 *
 * Fail-open: contact is additive; any DB error returns null.
 */
import type { Pool } from 'pg';
import { log } from '@bedrock/shared';

export interface CandidateContact {
    readonly name: string;
    readonly email: string;
    readonly linkedin?: string;
    readonly github?: string;
    readonly location?: string;
    readonly website?: string;
}

interface ResumeProfileRow {
    readonly name?: string;
    readonly email?: string;
    readonly linkedin?: string;
    readonly github?: string;
    readonly location?: string;
    readonly website?: string;
}

interface AuthIdentity {
    readonly fullName?: string;
    readonly email?: string;
}

const OPTIONAL_FIELDS = ['linkedin', 'github', 'location', 'website'] as const;

/** True when the row carries a usable name + email. */
function hasIdentity(name?: string, email?: string): boolean {
    return Boolean(name?.trim() && email?.trim());
}

/** Choose the best available contact: published resume profile, then auth identity. */
export function pickContact(profile: ResumeProfileRow | null, auth: AuthIdentity | null): CandidateContact | null {
    if (profile && hasIdentity(profile.name, profile.email)) {
        const contact: Record<string, string> = { name: profile.name!.trim(), email: profile.email!.trim() };
        for (const field of OPTIONAL_FIELDS) {
            const value = profile[field]?.trim();
            if (value) contact[field] = value;
        }
        return contact as unknown as CandidateContact;
    }
    if (auth && hasIdentity(auth.fullName, auth.email)) {
        return { name: auth.fullName!.trim(), email: auth.email!.trim() };
    }
    return null;
}

/** Render the user-message section. '' when no contact exists (writer must not invent). */
export function formatCandidateContact(contact: CandidateContact | null): string {
    if (!contact) return '';
    const fields = (['name', 'email', 'linkedin', 'github', 'location', 'website'] as const)
        .filter((f) => contact[f])
        .map((f) => `${f}: ${contact[f]}`);
    return [
        'These are the candidate\'s real contact details. Use them VERBATIM for the resume',
        'profile and the cover-letter signoff. NEVER invent or alter contact details;',
        'a field not listed here stays empty ("").',
        ...fields,
    ].join('\n');
}

/** Which source resolved the contact — observability for tenant onboarding. */
function contactSource(contact: CandidateContact | null, profile: ResumeProfileRow | null): string {
    if (!contact) return 'none';
    return profile && hasIdentity(profile.name, profile.email) ? 'resume_profile' : 'auth_identity';
}

/** Load the candidate's contact block text. Fail-open to ''. */
export async function loadCandidateContactBlock(pool: Pool, userId: string): Promise<string> {
    try {
        const [resumeRow, userRow] = await Promise.all([
            pool.query<{ profile: ResumeProfileRow | null }>(
                `SELECT content_json->'profile' AS profile FROM resumes WHERE user_id = $1 ORDER BY generated_at DESC LIMIT 1`,
                [userId],
            ),
            pool.query<{ full_name: string | null; email: string | null }>(
                `SELECT full_name, email FROM users WHERE id = $1`,
                [userId],
            ),
        ]);
        const profile = resumeRow.rows[0]?.profile ?? null;
        const authRow = userRow.rows[0];
        const auth = authRow ? { fullName: authRow.full_name ?? undefined, email: authRow.email ?? undefined } : null;
        const contact = pickContact(profile, auth);
        log('INFO', 'Candidate contact resolved', { agent: 'strategist', source: contactSource(contact, profile) });
        return formatCandidateContact(contact);
    } catch (e) {
        log('WARN', 'candidate contact load failed (non-fatal)', { agent: 'strategist', error: (e as Error).message });
        return '';
    }
}
