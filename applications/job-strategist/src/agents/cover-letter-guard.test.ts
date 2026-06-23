/** @format */
jest.mock('@bedrock/shared', () => ({
    ...jest.requireActual('@bedrock/shared'),
    runAgent: jest.fn(),
    log: () => undefined,
}));
import { runAgent } from '@bedrock/shared';
import { validateCoverLetter, guardCoverLetter, type CoverLetter } from './cover-letter-guard.js';

/** Wrap a body string in a structured CoverLetter for the content checks. */
const cl = (body: string): CoverLetter => ({
    greeting:   'Dear Hiring Manager,',
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
    it('flags a forward-looking skill-acquisition claim (the Azure/GCP fabrication)', () => {
        const letter = { greeting: 'Dear Hiring Manager', paragraphs: ['My AWS depth is strong and I am actively beginning Azure and GCP onboarding, pursued with urgency.'], signoff: SIGNOFF } as never;
        const v = validateCoverLetter(letter, 'Solutions Support Engineer', '');
        expect(v.some((x) => x.code === 'forward_looking_skill_claim')).toBe(true);
    });
    it('does NOT flag legitimate "onboarding" usage (people, not a skill the candidate lacks)', () => {
        const letter = { greeting: 'Dear Hiring Manager', paragraphs: ['I authored the runbook adopted for new engineer onboarding across the team.'], signoff: SIGNOFF } as never;
        const v = validateCoverLetter(letter, 'Solutions Support Engineer', '');
        expect(v.some((x) => x.code === 'forward_looking_skill_claim')).toBe(false);
    });
    it('flags base-form acquire verb: "actively learn Azure"', () => {
        const letter = { greeting: 'Dear Hiring Manager', paragraphs: ['I will actively learn Azure.'], signoff: SIGNOFF } as never;
        const v = validateCoverLetter(letter, 'Solutions Support Engineer', '');
        expect(v.some((x) => x.code === 'forward_looking_skill_claim')).toBe(true);
    });
    it('flags the base-form "self-teach" variant', () => {
        const letter = { greeting: 'Dear Hiring Manager', paragraphs: ['I am actively self-teach Rust for this role.'], signoff: SIGNOFF } as never;
        const v = validateCoverLetter(letter, 'Solutions Support Engineer', '');
        expect(v.some((x) => x.code === 'forward_looking_skill_claim')).toBe(true);
    });
    it('does NOT flag acquire verb that precedes intent word (order matters)', () => {
        const letter = { greeting: 'Dear Hiring Manager', paragraphs: ['I onboarding actively into other things.'], signoff: SIGNOFF } as never;
        const v = validateCoverLetter(letter, 'Solutions Support Engineer', '');
        expect(v.some((x) => x.code === 'forward_looking_skill_claim')).toBe(false);
    });
    it('does NOT flag across sentence boundary (period between intent and acquire)', () => {
        const letter = { greeting: 'Dear Hiring Manager', paragraphs: ['I am beginning the role. Now, actively, I help customers.'], signoff: SIGNOFF } as never;
        const v = validateCoverLetter(letter, 'Solutions Support Engineer', '');
        expect(v.some((x) => x.code === 'forward_looking_skill_claim')).toBe(false);
    });
    it('flags a body sentence longer than 40 words (long_sentence)', () => {
        const long = 'When a silent IAM failure caused every Bedrock Rerank call to fall back to cosine retrieval with no user-visible error I diagnosed it via simulate-principal-policy confirming InvokeModel was allowed while Rerank returned an implicit deny and then corrected the Pod Identity policy in CDK and verified the fix with a live Rerank API test against the running cluster.';
        const letter = { greeting: 'Dear Hiring Manager,', paragraphs: [long], signoff: SIGNOFF } as never;
        expect(validateCoverLetter(letter, 'Solutions Support Engineer', '').some((v) => v.code === 'long_sentence')).toBe(true);
    });
    it('does not flag a letter of short sentences', () => {
        const letter = { greeting: 'Dear Hiring Manager,', paragraphs: ['I resolve IAM incidents at AWS. I traced a compromised key through CloudTrail. I fixed the trust policy fast.'], signoff: SIGNOFF } as never;
        expect(validateCoverLetter(letter, 'Solutions Support Engineer', '').some((v) => v.code === 'long_sentence')).toBe(false);
    });
    it('flags a greeting without a trailing comma (greeting_format)', () => {
        const letter = { greeting: 'Dear Hiring Manager', paragraphs: ['I resolve IAM incidents.'], signoff: SIGNOFF } as never;
        expect(validateCoverLetter(letter, 'Solutions Support Engineer', '').some((v) => v.code === 'greeting_format')).toBe(true);
    });
    it('accepts a greeting with a trailing comma', () => {
        const letter = { greeting: 'Dear Hiring Manager,', paragraphs: ['I resolve IAM incidents.'], signoff: SIGNOFF } as never;
        expect(validateCoverLetter(letter, 'Solutions Support Engineer', '').some((v) => v.code === 'greeting_format')).toBe(false);
    });
});

const mockRun = runAgent as jest.Mock;

const SIGNOFF = { name: 'Nelson', email: 'n@x.com', linkedin: 'l', github: 'g' };
const clObj = (paras: string[]): CoverLetter => ({ greeting: 'Dear Hiring Manager,', paragraphs: paras, signoff: SIGNOFF });

describe('guardCoverLetter', () => {
    beforeEach(() => { mockRun.mockReset(); });

    it('null letter → passthrough, no rewrite call', async () => {
        const r = await guardCoverLetter(null, 'AI Support Engineer', 'User Operations Engineer', '');
        expect(r.letter).toBeNull();
        expect(mockRun).not.toHaveBeenCalled();
    });
    it('clean letter → unchanged, no rewrite call', async () => {
        const clean = clObj(['I build production AI support. The AI Support Engineer role at OpenAI fits.']);
        const r = await guardCoverLetter(clean, 'AI Support Engineer', 'User Operations Engineer', '');
        expect(r.letter).toStrictEqual(clean);
        expect(r.violations).toEqual([]);
        expect(mockRun).not.toHaveBeenCalled();
    });
    it('violations → calls rewrite, returns rewritten letter + original violations', async () => {
        const fixed = clObj(['I build production AI support systems for the AI Support Engineer role.']);
        mockRun.mockResolvedValue({ data: fixed });
        const bad = clObj(['My 3 years falls short of the 8-year threshold.']);  // missing_title + names_gap
        const r = await guardCoverLetter(bad, 'AI Support Engineer', 'User Operations Engineer', '5 years across support');
        expect(r.letter).toStrictEqual(fixed);
        expect(r.violations.map((v) => v.code)).toEqual(expect.arrayContaining(['missing_title', 'names_gap']));
    });
    it('rewrite throws → returns ORIGINAL letter (fail-open)', async () => {
        mockRun.mockRejectedValue(new Error('bedrock down'));
        const bad = clObj(['My 3 years falls short of the threshold.']);
        const r = await guardCoverLetter(bad, 'AI Support Engineer', 'User Operations Engineer', '');
        expect(r.letter).toStrictEqual(bad);
    });
    it('clean letter with em-dash → em-dash replaced by comma, no rewrite call', async () => {
        const withDash = clObj(['I build production AI support — the biggest win. The AI Support Engineer role at OpenAI fits.']);
        const r = await guardCoverLetter(withDash, 'AI Support Engineer', 'User Operations Engineer', '');
        expect(r.violations).toEqual([]);
        expect(mockRun).not.toHaveBeenCalled();
        expect(r.letter?.paragraphs[0]).toBe('I build production AI support, the biggest win. The AI Support Engineer role at OpenAI fits.');
    });
});
