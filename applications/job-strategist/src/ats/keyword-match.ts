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

// Generic "scripting / programming / languages" JD terms don't appear verbatim in
// resumes, which list concrete languages. Credit such a term when the resume
// demonstrates a real language — honest (the candidate genuinely codes). Deliberately
// NARROW: only language/scripting/programming/coding cues, never bare "automation"
// (that would over-credit gaps like "AI-driven customer support automation").
const LANG_CATEGORY_CUE = /\b(languages?|scripting|programming|coding)\b/;
const LANGUAGE_EXEMPLARS = [
    ' python ', ' bash ', ' shell ', ' powershell ', ' sql ', ' javascript ', ' typescript ',
    ' golang ', ' java ', ' ruby ', ' rust ', ' kotlin ', ' scala ', ' perl ',
];

function matchSkillCategory(rawTermLower: string, paddedResume: string): boolean {
    if (!LANG_CATEGORY_CUE.test(rawTermLower)) return false;
    return LANGUAGE_EXEMPLARS.some((ex) => paddedResume.includes(ex));
}

export function matchTier1(term: string, resumeLowerText: string): boolean {
    const resume = normalizeResume(resumeLowerText);
    const normTerm = normalizeTerm(term);
    if (normTerm.length > 0) {
        // Word-boundary substring (space-padded) — so "go" does NOT match "going" and a
        // 2-char atomic skill ("ML", "QA") matches its own word, not a substring of another.
        if (resume.includes(` ${normTerm} `)) return true;
        const tokens = normTerm.split(' ').filter((t) => t.length >= 3);
        if (tokens.length > 0 && tokens.every((tok) => resume.includes(` ${tok} `))) return true;
    }
    // Skill-category credit — e.g. "scripting languages" reduces to "languages" and won't
    // match literally, but the resume lists Python/Bash → the language skill IS present.
    return matchSkillCategory(term.toLowerCase(), resume);
}

/**
 * Significant-token overlap — bridges differently-phrased competencies.
 *
 * "Critical thinking and root cause analysis" vs "...root-cause analysis" → shares
 * {root,cause,analysis}. Reuses `normalizeTerm` (strips qualifier/suffix noise), then
 * compares the sets of significant (≥3-char) tokens.
 *
 * Matches when ≥ `minShared` tokens overlap OR ≥ 60% of the smaller token set overlaps
 * (so a short, fully-contained phrase like "alerting" vs "alerting dashboards" bridges).
 */
export function tokenOverlapMatch(a: string, b: string, minShared = 2): boolean {
    const toks = (s: string) => new Set(normalizeTerm(s).split(' ').filter((t) => t.length >= 3));
    const A = toks(a), B = toks(b);
    if (A.size === 0 || B.size === 0) return false;
    let shared = 0;
    for (const t of A) if (B.has(t)) shared++;
    // match if ≥ minShared shared tokens OR ≥ 60% of the smaller set overlaps
    return shared >= minShared || shared / Math.min(A.size, B.size) >= 0.6;
}

export type MatchTier = 'literal' | 'normalized' | 'ontology' | 'tech-transfer' | 'embedding' | 'none';
export interface Embedder { embed(text: string): Promise<number[]>; }
export interface MatchCtx {
    familyVocab: string[][];
    embedder: Embedder | null;
    threshold: number;
    resumeVector?: number[];
    /** Transfer/category groups — arrays of lowercased canonical tech names. Optional. */
    techGroups?: string[][];
    /** Alias → canonical map (lowercased keys). Optional. */
    techAliasMap?: Map<string, string>;
}

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
 * Build a reverse map: canonical → all surface forms (display form + all aliases).
 * Display form is derived by replacing underscores with spaces in the canonical.
 */
export function buildReverseAliasMap(aliasMap: ReadonlyMap<string, string>): Map<string, string[]> {
    const reverse = new Map<string, string[]>();
    for (const [alias, canonical] of aliasMap) {
        const existing = reverse.get(canonical);
        if (existing) {
            existing.push(alias);
        } else {
            reverse.set(canonical, [alias]);
        }
    }
    return reverse;
}

/**
 * Tech-transfer tier: resolve the JD term to a canonical, find its tech group,
 * then check if the resume mentions any sibling canonical's surface forms.
 *
 * @param term             - JD term (raw, mixed case)
 * @param resumeLowerText  - Full resume text (lowercased)
 * @param techGroups       - Groups of mutually-transferable canonical tech names (lowercased)
 * @param aliasMap         - alias→canonical map (lowercased keys)
 */
export function matchTechTransfer(
    term: string,
    resumeLowerText: string,
    techGroups: string[][],
    aliasMap: Map<string, string>,
): boolean {
    const termLower = term.toLowerCase().trim();
    // Resolve term → canonical: check aliasMap first, then normalized form
    const jdCanonical = aliasMap.get(termLower) ?? normalizeTerm(term).replace(/ /g, '_');

    const reverseMap = buildReverseAliasMap(aliasMap);
    const resume = normalizeResume(resumeLowerText);

    for (const group of techGroups) {
        if (!group.includes(jdCanonical)) continue;

        // Found a group containing this JD term; check siblings
        for (const sibling of group) {
            if (sibling === jdCanonical) continue;

            // Surface forms = display form (underscore→space) + all aliases for this canonical
            const displayForm = sibling.replace(/_/g, ' ');
            const aliases = reverseMap.get(sibling) ?? [];
            const surfaceForms = new Set([displayForm, ...aliases]);

            for (const form of surfaceForms) {
                const normForm = normalizeTerm(form);
                if (normForm.length > 0 && resume.includes(` ${normForm} `)) return true;
            }
        }
    }

    return false;
}

/**
 * 4-tier keyword match: literal → normalized (Tier 1) → ontology (Tier 2) → tech-transfer (Tier 3) → embedding (Tier 4).
 * Embedding only runs on tier1-3 misses (cost). FAIL-OPEN: embedder error → no false credit.
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
    if (ctx.techGroups && ctx.techAliasMap && matchTechTransfer(term, resumeLowerText, ctx.techGroups, ctx.techAliasMap)) {
        return { present: true, tier: 'tech-transfer' };
    }
    if (ctx.embedder) {
        try {
            const rv = ctx.resumeVector ?? (await ctx.embedder.embed(resumeLowerText.slice(0, 8000)));
            const tv = await ctx.embedder.embed(term);
            if (cosine(rv, tv) >= ctx.threshold) return { present: true, tier: 'embedding' };
        } catch { /* fail-open — no false credit */ }
    }
    return { present: false, tier: 'none' };
}
