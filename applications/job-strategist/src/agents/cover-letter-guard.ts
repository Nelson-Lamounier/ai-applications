/** @format */

export interface CoverLetterViolation { code: string; detail: string; }

/** Structured cover letter — plain text, NO markdown. The UI + PDF own all formatting. */
export interface CoverLetterSignoff { name: string; email: string; linkedin: string; github: string; }
export interface CoverLetter {
    greeting:   string;
    paragraphs: string[];
    signoff:    CoverLetterSignoff;
}

const GAP_PATTERNS: ReadonlyArray<RegExp> = [
    /falls?\s+short/i,
    /(?:do not|does not|have not|don['’]t|doesn['’]t|haven['’]t)\s+yet\s+have/i,
    /lack(?:ing)?\s+(?:direct\s+|hands-on\s+)?experience/i,
    /\b\d{1,2}\s*years?\b[^.]{0,40}\b(?:short|threshold|bar|requirement|fall)/i,
    /I would be surprised/i,
    /while I (?:do not|have not|don['’]t|haven['’]t|lack)\b/i,
];
const UNREALISED = /pending (?:security )?review|not yet (?:shipped|deployed|in production)|once (?:approved|shipped)/i;
/** Any markdown the agent should NOT emit (formatting belongs to the UI/PDF). */
const MARKDOWN = /\*\*|__|##|^\s*[-*+]\s+/m;

/**
 * Deterministic checks on the STRUCTURED cover letter. Content rules (title,
 * self-rejection, unrealised impact) run on the joined text; `has_markdown`
 * ensures the agent emitted clean prose — formatting is the renderer's job.
 */
export function validateCoverLetter(letter: CoverLetter, targetRole: string, leadIdentity: string): CoverLetterViolation[] {
    const out: CoverLetterViolation[] = [];
    const text  = [letter.greeting, ...letter.paragraphs].join('\n');
    const lower = text.toLowerCase();

    if (targetRole && !lower.includes(targetRole.toLowerCase())) {
        out.push({ code: 'missing_title', detail: `Body never names the target role "${targetRole}".` });
    }
    if (leadIdentity && leadIdentity.toLowerCase() !== targetRole.toLowerCase()) {
        const li = leadIdentity.toLowerCase();
        if (lower.includes(`${li} role`) || lower.includes(`${li} position`)) {
            out.push({ code: 'wrong_title', detail: `Body uses the positioning identity "${leadIdentity}" as the role name.` });
        }
    }
    for (const re of GAP_PATTERNS) {
        if (re.test(text)) { out.push({ code: 'names_gap', detail: `Matched self-rejection/arguing pattern: ${re}` }); break; }
    }
    if (UNREALISED.test(text)) out.push({ code: 'unrealised_impact', detail: 'Claims not-yet-realised impact.' });
    if (MARKDOWN.test(text))   out.push({ code: 'has_markdown', detail: 'Agent emitted markdown formatting — the UI/PDF owns formatting; output must be plain text.' });

    return out;
}
