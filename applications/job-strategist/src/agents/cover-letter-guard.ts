/** @format */

export interface CoverLetterViolation { code: string; detail: string; }

const GAP_PATTERNS: ReadonlyArray<{ code: string; re: RegExp }> = [
    { code: 'names_gap', re: /falls?\s+short/i },
    { code: 'names_gap', re: /do(?:es)?\s*n['']?t\s+yet\s+have|do not yet have|have not yet|lack(?:ing)?\s+(?:direct\s+|hands-on\s+)?experience/i },
    { code: 'names_gap', re: /\b\d{1,2}\s*years?\b[^.]{0,40}\b(?:short|threshold|bar|requirement|fall)/i },
    { code: 'names_gap', re: /I would be surprised/i },
    { code: 'names_gap', re: /while I (?:do\s*n['']?t|do not|have\s*n['']?t|lack)/i },
];
const UNREALISED = /pending (?:security )?review|not yet (?:shipped|deployed|in production)|once (?:approved|shipped)/i;
const MAX_BOLD = 4;

/** Deterministic cover-letter checks. */
export function validateCoverLetter(letter: string, targetRole: string, leadIdentity: string): CoverLetterViolation[] {
    const out: CoverLetterViolation[] = [];
    const lower = letter.toLowerCase();

    if (targetRole && !lower.includes(targetRole.toLowerCase())) {
        out.push({ code: 'missing_title', detail: `Body never names the target role "${targetRole}".` });
    }
    if (leadIdentity && leadIdentity.toLowerCase() !== targetRole.toLowerCase()) {
        const li = leadIdentity.toLowerCase();
        if (lower.includes(`${li} role`) || lower.includes(`${li} position`)) {
            out.push({ code: 'wrong_title', detail: `Body uses the positioning identity "${leadIdentity}" as the role name.` });
        }
    }
    for (const { code, re } of GAP_PATTERNS) {
        if (re.test(letter)) { out.push({ code, detail: `Matched self-rejection/arguing pattern: ${re}` }); break; }
    }
    const boldCount = (letter.match(/\*\*[^*]+\*\*/g) ?? []).length;
    if (boldCount > MAX_BOLD) out.push({ code: 'too_bold', detail: `${boldCount} bold spans (max ${MAX_BOLD}).` });
    if (UNREALISED.test(letter)) out.push({ code: 'unrealised_impact', detail: 'Claims not-yet-realised impact.' });

    return out;
}
