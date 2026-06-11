/** @format */
import { validateCoverLetter } from './cover-letter-guard.js';

const codes = (l: string, target = 'AI Support Engineer', lead = 'User Operations Engineer') =>
    validateCoverLetter(l, target, lead).map((v) => v.code);

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
    it('flags too much bold', () => {
        const many = '**a** **b** **c** **d** **e** AI Support Engineer';
        expect(codes(many)).toContain('too_bold');
    });
    it('flags unrealised impact', () => {
        expect(codes('The system is pending security review. AI Support Engineer.')).toContain('unrealised_impact');
    });
    it('clean letter → no violations', () => {
        expect(codes('I build production AI support systems. The AI Support Engineer role at OpenAI fits exactly. **OpenAI**.')).toEqual([]);
    });
});
