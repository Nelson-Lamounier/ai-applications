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

export type MatchTier = 'literal' | 'normalized' | 'ontology' | 'embedding' | 'none';
export interface Embedder { embed(text: string): Promise<number[]>; }
export interface MatchCtx { familyVocab: string[][]; embedder: Embedder | null; threshold: number; resumeVector?: number[]; }

function cosine(a: number[], b: number[]): number {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    if (na === 0 || nb === 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Tier 2 — the JD term is in a resolved family's vocab group AND the resume contains another vocab term from that group. */
function matchOntology(term: string, resumeLowerText: string, familyVocab: string[][]): boolean {
    const nt = normalizeTerm(term);
    if (!nt) return false;
    const resume = ' ' + resumeLowerText.toLowerCase().replace(/[^a-z0-9]+/g, ' ') + ' ';
    for (const group of familyVocab) {
        const normGroup = group.map(normalizeTerm).filter((g) => g.length > 0);
        if (!normGroup.includes(nt)) continue;
        if (normGroup.some((v) => v !== nt && resume.includes(` ${v} `))) return true;
    }
    return false;
}

/**
 * 3-tier keyword match. literal -> normalized (Tier 1) -> ontology (Tier 2) -> embedding (Tier 3).
 * Tier 3 only runs on tier1+2 misses (cost). FAIL-OPEN: embedder error -> no false credit.
 */
export async function matchTerm(
    term: string,
    resumeLowerText: string,
    ctx: MatchCtx,
): Promise<{ present: boolean; tier: MatchTier }> {
    const raw = term.toLowerCase().trim();
    const resume = ' ' + resumeLowerText.toLowerCase().replace(/[^a-z0-9]+/g, ' ') + ' ';
    if (raw && resume.includes(` ${raw} `)) return { present: true, tier: 'literal' };
    if (matchTier1(term, resumeLowerText)) return { present: true, tier: 'normalized' };
    if (matchOntology(term, resumeLowerText, ctx.familyVocab)) return { present: true, tier: 'ontology' };
    if (ctx.embedder) {
        try {
            const rv = ctx.resumeVector ?? (await ctx.embedder.embed(resumeLowerText.slice(0, 8000)));
            const tv = await ctx.embedder.embed(term);
            if (cosine(rv, tv) >= ctx.threshold) return { present: true, tier: 'embedding' };
        } catch { /* fail-open — no false credit */ }
    }
    return { present: false, tier: 'none' };
}
