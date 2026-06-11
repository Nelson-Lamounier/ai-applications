/** @format */
import { validateCoverLetter, type CoverLetter } from './cover-letter-guard.js';

/** Wrap a body string in a structured CoverLetter for the content checks. */
const cl = (body: string): CoverLetter => ({
    greeting:   'Dear Hiring Manager',
    paragraphs: [body],
    signoff:    { name: 'Nelson', email: 'n@x.com', linkedin: 'l', github: 'g' },
});
const codes = (body: string, target = 'AI Support Engineer', lead = 'User Operations Engineer') =>
    validateCoverLetter(cl(body), target, lead).map((v) => v.code);

describe('validateCoverLetter', () => {
    it('flags missing JD title', () => {
        expect(codes('I am excited about the User Operations Engineer role at OpenAI.')).toContain('missing_title');
    });
    it('flags using the lead-identity as the role name', () => {
        expect(codes('Applying for the User Operations Engineer role; I am an AI Support Engineer fit.')).toContain('wrong_title');
    });
    it('flags self-rejection / gap-naming / arguing phrases', () => {
        expect(codes('My 3 years falls short of the 8-year threshold for AI Support Engineer.')).toContain('names_gap');
        expect(codes('I do not yet have direct hands-on experience with the API (AI Support Engineer).')).toContain('names_gap');
        expect(codes('I would be surprised if many candidates match this. AI Support Engineer.')).toContain('names_gap');
    });
    it('flags markdown formatting (formatting belongs to the UI/PDF, not the agent)', () => {
        expect(codes('I am a strong **fit** for the AI Support Engineer role.')).toContain('has_markdown');
        expect(codes('## Opening\nThe AI Support Engineer role suits me.')).toContain('has_markdown');
    });
    it('flags unrealised impact', () => {
        expect(codes('The system is pending security review. AI Support Engineer.')).toContain('unrealised_impact');
    });
    it('clean structured letter → no violations', () => {
        expect(codes('I build production AI support systems. The AI Support Engineer role at OpenAI fits exactly.')).toEqual([]);
    });
});
