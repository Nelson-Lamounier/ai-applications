/** @format */
jest.mock('@bedrock/shared', () => ({
    ...jest.requireActual('@bedrock/shared'),
    runAgent: jest.fn(),
    log: () => undefined,
}));
import { runAgent } from '@bedrock/shared';
import { validateCoverLetter, validateCoverLetterNarrative, guardCoverLetter, stripThirdPersonSentences, type CoverLetter } from '../cover-letter-guard.js';

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
        const clean = clObj(['I build production AI support. The AI Support Engineer role at OpenAI fits.', 'I own the platform end to end as a solo operator.', 'I would bring that operating depth to your team.']);
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
        const withDash = clObj(['I build production AI support — the biggest win. The AI Support Engineer role at OpenAI fits.', 'I own the platform end to end as a solo operator.', 'I would bring that operating depth to your team.']);
        const r = await guardCoverLetter(withDash, 'AI Support Engineer', 'User Operations Engineer', '');
        expect(r.violations).toEqual([]);
        expect(mockRun).not.toHaveBeenCalled();
        expect(r.letter?.paragraphs[0]).toBe('I build production AI support, the biggest win. The AI Support Engineer role at OpenAI fits.');
    });
});

describe('third-person voice (framingLine leakage)', () => {
    beforeEach(() => { mockRun.mockReset(); });

    it('flags "this candidate" phrasing as third_person_voice', () => {
        const letter = clObj(['Across support roles, this candidate brings approximately 5 years of experience. The AI Support Engineer role fits.']);
        const v = validateCoverLetter(letter, 'AI Support Engineer', '');
        expect(v.map((x) => x.code)).toContain('third_person_voice');
    });

    it("flags the possessive \"the candidate's\" form", () => {
        const letter = clObj(["The candidate's AWS depth is strong. The AI Support Engineer role fits."]);
        const v = validateCoverLetter(letter, 'AI Support Engineer', '');
        expect(v.map((x) => x.code)).toContain('third_person_voice');
    });

    it('does not flag first-person tenure framing', () => {
        const letter = clObj(['I bring approximately 5 years across support and cloud infrastructure. The AI Support Engineer role fits.']);
        const v = validateCoverLetter(letter, 'AI Support Engineer', '');
        expect(v.map((x) => x.code)).not.toContain('third_person_voice');
    });

    it('stripThirdPersonSentences deletes only the offending sentence', () => {
        const letter = clObj(['This candidate brings 5 years of experience. I built the production RAG pipeline end-to-end.']);
        const { letter: out, stripped } = stripThirdPersonSentences(letter);
        expect(stripped).toBe(true);
        expect(out.paragraphs[0]).toBe('I built the production RAG pipeline end-to-end.');
    });

    it('guardCoverLetter deterministically strips third-person left behind by the rewrite', async () => {
        const stillBad = clObj(['This candidate brings 5 years of experience. I fit the AI Support Engineer role.']);
        mockRun.mockResolvedValue({ data: stillBad });
        const bad = clObj(['Across roles, this candidate brings 5 years. I fit the AI Support Engineer role.']);
        const r = await guardCoverLetter(bad, 'AI Support Engineer', '', '5 years across support');
        expect(r.violations.map((v) => v.code)).toEqual(expect.arrayContaining(['third_person_voice', 'third_person_stripped']));
        expect(r.letter?.paragraphs.join(' ')).not.toMatch(/this candidate/i);
    });
});

describe('validateCoverLetterNarrative', () => {
    const letter = (paras: string[]): CoverLetter => clObj(paras);

    it('flags a jargon-dense P1 (the SSMClient/prom-client opener)', () => {
        const v = validateCoverLetterNarrative(letter([
            'The /api/metrics endpoint was hanging because the SSMClient had no TCP timeout and no VPC endpoint existed; prom-client was bundled twice by webpack, splitting the Registry singleton. I added an AbortController timeout.',
        ]), {});
        expect(v.map((x) => x.code)).toContain('opener_too_technical');
    });

    it('passes a plain-language recruiter-readable P1', () => {
        const v = validateCoverLetterNarrative(letter([
            'I want this role because the problem it exists to solve, helping teams ship reliably and securely, is the exact problem I chose to spend the last years solving on my own platform.',
        ]), {});
        expect(v.map((x) => x.code)).not.toContain('opener_too_technical');
    });

    it('flags tenure mentions when the JD sets no years bar', () => {
        const v = validateCoverLetterNarrative(letter([
            'I want this role for its mission.',
            'I have spent approximately five years, well, 5 years across delivery.',
        ]), { hasYearsBar: false });
        expect(v.map((x) => x.code)).toContain('tenure_without_bar');
    });

    it('allows tenure when a years bar exists', () => {
        const v = validateCoverLetterNarrative(letter(['I bring 5 years across support and cloud.']), { hasYearsBar: true });
        expect(v.map((x) => x.code)).not.toContain('tenure_without_bar');
    });

    it('flags a letter repeating more than one resume number', () => {
        const v = validateCoverLetterNarrative(letter([
            'I run 22 workflows and a 16-stack monorepo with 265 assertions.',
        ]), { resumeNumbers: new Set(['22', '16', '265']) });
        expect(v.map((x) => x.code)).toContain('letter_restates_resume');
    });

    it('allows one shared number', () => {
        const v = validateCoverLetterNarrative(letter([
            'My platform serves users through 25 continuously delivered applications.',
        ]), { resumeNumbers: new Set(['25', '16']) });
        expect(v.map((x) => x.code)).not.toContain('letter_restates_resume');
    });
});
