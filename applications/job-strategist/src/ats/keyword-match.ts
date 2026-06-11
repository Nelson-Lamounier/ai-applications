/** @format */

const QUALIFIERS = new Set([
    'expert', 'expertlevel', 'level', 'strong', 'advanced', 'solid', 'proven', 'excellent',
    'skills', 'skill', 'capabilities', 'capability', 'experience', 'experienced', 'knowledge',
    'proficiency', 'proficient', 'ability', 'hands', 'on', 'handson', 'similar', 'etc',
    'implied', 'eg', 'ie',
    'and', 'or', 'the', 'a', 'an', 'of', 'in', 'with', 'for', 'to',
    'scripting', 'systems', 'system', 'tools', 'tooling', 'management', 'collaboration',
    'communication',
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
    if (resume.includes(normTerm)) return true;
    const tokens = normTerm.split(' ').filter((t) => t.length >= 3);
    if (tokens.length === 0) return false;
    return tokens.every((tok) => resume.includes(` ${tok} `));
}
