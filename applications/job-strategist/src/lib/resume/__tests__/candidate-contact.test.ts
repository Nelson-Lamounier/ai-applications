/**
 * @format
 * Candidate contact block — the per-user replacement for the persona's
 * hardcoded sign-off identity.
 *
 * Until 2026-07-09 the strategist persona's cover-letter template carried ONE
 * user's literal name/email/linkedin/github as the signoff example, and no
 * per-user contact reached the writer — any other tenant's cover letter and
 * resume profile would have shipped with that user's identity. Contact now
 * arrives as a labelled user-message section sourced from the user's own data.
 */
import { describe, it, expect } from '@jest/globals';
import { formatCandidateContact, pickContact, type CandidateContact } from '../candidate-contact.js';

describe('pickContact', () => {
    it('prefers the latest resume profile (the contact the user actually publishes)', () => {
        const c = pickContact(
            { name: 'Ada Lovelace', email: 'ada@calc.dev', linkedin: 'linkedin.com/in/ada', github: 'github.com/ada', location: 'London' },
            { fullName: 'ada-auth', email: 'ada@auth-provider.example' },
        );
        expect(c).toEqual({ name: 'Ada Lovelace', email: 'ada@calc.dev', linkedin: 'linkedin.com/in/ada', github: 'github.com/ada', location: 'London' });
    });

    it('falls back to the auth identity when no resume profile exists (new tenant, first run)', () => {
        const c = pickContact(null, { fullName: 'Grace Hopper', email: 'grace@navy.example' });
        expect(c).toEqual({ name: 'Grace Hopper', email: 'grace@navy.example' });
    });

    it('ignores a resume profile with no usable name/email (placeholder rows)', () => {
        const c = pickContact({ name: '', email: '' }, { fullName: 'Grace Hopper', email: 'grace@navy.example' });
        expect(c?.name).toBe('Grace Hopper');
    });

    it('returns null when nothing is available (block omitted, writer must not invent)', () => {
        expect(pickContact(null, null)).toBeNull();
    });
});

describe('formatCandidateContact', () => {
    it('renders only the fields that exist — the writer is told to omit the rest, never invent', () => {
        const block = formatCandidateContact({ name: 'Grace Hopper', email: 'grace@navy.example' } as CandidateContact);
        expect(block).toContain('name: Grace Hopper');
        expect(block).toContain('email: grace@navy.example');
        expect(block).not.toContain('linkedin');
        expect(block).toContain('NEVER invent or alter contact details');
    });

    it('returns empty for null contact', () => {
        expect(formatCandidateContact(null)).toBe('');
    });
});
