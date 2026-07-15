/**
 * @format
 * Synthetic cover-letter-agent eval fixtures - no Bedrock, no PII.
 *
 * GOLDEN passes every grader: exactly 3 paragraphs, a complete signoff, no
 * em-dash, first-person throughout, and (with hasYearsBar false) no tenure
 * mention at all. Each adversarial variant breaks exactly one grader's
 * invariant while leaving the other four untouched.
 */
import type { CoverLetter } from '@bedrock/shared';
import type { CoverLetterEvalInput } from './cover-letter-graders.js';

const SIGNOFF = { name: 'Jane Doe', email: 'jane@example.com', linkedin: 'linkedin.com/in/janedoe', github: 'github.com/janedoe' };

const GOLDEN_LETTER: CoverLetter = {
    greeting: 'Dear Hiring Manager,',
    paragraphs: [
        "I'm excited about the Site Reliability Engineer role at Acme because it lets me put my incident-response experience to direct use for your platform team.",
        'In my most recent role I owned reliability for a multi-region platform, cutting incident response time and mentoring on-call engineers through a growing service catalogue.',
        'I would welcome the chance to bring that ownership to Acme and am happy to discuss further at your convenience.',
    ],
    signoff: SIGNOFF,
};

export const GOLDEN_LETTER_INPUT: CoverLetterEvalInput = {
    letter: GOLDEN_LETTER,
    hasYearsBar: false,
};

/**
 * Adversarial: only 2 paragraphs (the last two merged) -- trips ONLY
 * paragraphCountGrader; signoff, prose, and tenure content are unchanged.
 */
export const ADVERSARIAL_PARAGRAPH_COUNT: CoverLetterEvalInput = {
    letter: {
        ...GOLDEN_LETTER,
        paragraphs: [
            GOLDEN_LETTER.paragraphs[0]!,
            `${GOLDEN_LETTER.paragraphs[1]!} ${GOLDEN_LETTER.paragraphs[2]!}`,
        ],
    },
    hasYearsBar: false,
};

/**
 * Adversarial: the signoff email is blank -- trips ONLY signoffCompleteGrader;
 * paragraph count, prose, and tenure content are unchanged.
 */
export const ADVERSARIAL_SIGNOFF: CoverLetterEvalInput = {
    letter: { ...GOLDEN_LETTER, signoff: { ...SIGNOFF, email: '' } },
    hasYearsBar: false,
};

/**
 * Adversarial: the second paragraph carries an em-dash -- trips ONLY
 * noEmDashGrader; paragraph count, signoff, and tenure content are unchanged.
 */
export const ADVERSARIAL_EM_DASH: CoverLetterEvalInput = {
    letter: {
        ...GOLDEN_LETTER,
        paragraphs: [
            GOLDEN_LETTER.paragraphs[0]!,
            'In my most recent role I owned reliability for a multi-region platform \u2014 cutting incident response time and mentoring on-call engineers.',
            GOLDEN_LETTER.paragraphs[2]!,
        ],
    },
    hasYearsBar: false,
};

/**
 * Adversarial: hasYearsBar is false (the JD sets no years requirement) but P2
 * states "5+ years leading reliability work" -- trips ONLY
 * tenureConditionalGrader; paragraph count, signoff, and voice are unchanged.
 */
export const ADVERSARIAL_TENURE: CoverLetterEvalInput = {
    letter: {
        ...GOLDEN_LETTER,
        paragraphs: [
            GOLDEN_LETTER.paragraphs[0]!,
            'In my 5+ years leading reliability work I have owned incident response and mentored on-call engineers across a growing service catalogue.',
            GOLDEN_LETTER.paragraphs[2]!,
        ],
    },
    hasYearsBar: false,
};

/**
 * Adversarial: the closing paragraph slips into third person ("this
 * candidate") -- trips ONLY thirdPersonGrader; paragraph count, signoff, and
 * tenure content are unchanged.
 */
export const ADVERSARIAL_THIRD_PERSON: CoverLetterEvalInput = {
    letter: {
        ...GOLDEN_LETTER,
        paragraphs: [
            GOLDEN_LETTER.paragraphs[0]!,
            GOLDEN_LETTER.paragraphs[1]!,
            'This candidate would welcome the chance to bring that ownership to Acme and is happy to discuss further at your convenience.',
        ],
    },
    hasYearsBar: false,
};
