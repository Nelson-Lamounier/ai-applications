/** @format */

const QUALIFIERS = new Set([
    'expert', 'expertlevel', 'level', 'strong', 'advanced', 'solid', 'proven', 'excellent',
    'skills', 'skill', 'capabilities', 'capability', 'experience', 'experienced', 'knowledge',
    'proficiency', 'proficient', 'ability', 'hands', 'on', 'handson', 'similar', 'etc',
    'implied', 'eg', 'ie',
    'and', 'or', 'the', 'a', 'an', 'of', 'in', 'with', 'for', 'to',
    // Generic tech-suffix noise — strip so a multi-word skill reduces to its distinctive
    // core ("Python scripting" -> "python", "ticketing systems" -> "ticketing"). Soft-skill
    // CONTENT words (management / communication / collaboration) are NOT stripped — they
    // carry the requirement, and stripping them over-credits ("project management" -> any
    // resume that says "project").
    'scripting', 'systems', 'system', 'tools', 'tooling',
]);

export function normalizeTerm(t: string): string {
    return t
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .split(/\s+/)
        .filter((tok) => tok.length > 0 && !QUALIFIERS.has(tok))
        .join(' ');
}

function normalizeResume(text: string): string {
    return ' ' + text.toLowerCase().replace(/[^a-z0-9]+/g, ' ') + ' ';
}

export function matchTier1(term: string, resumeLowerText: string): boolean {
    const normTerm = normalizeTerm(term);
    if (normTerm.length === 0) return false;
    const resume = normalizeResume(resumeLowerText);
    // Word-boundary substring (space-padded) — so "go" does NOT match "going" and a
    // 2-char atomic skill ("ML", "QA") matches its own word, not a substring of another.
    if (resume.includes(` ${normTerm} `)) return true;
    const tokens = normTerm.split(' ').filter((t) => t.length >= 3);
    if (tokens.length === 0) return false;
    return tokens.every((tok) => resume.includes(` ${tok} `));
}
