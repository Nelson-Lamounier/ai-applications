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

// F4: multi-word terms need PROXIMITY, not just co-presence — "project" and "management"
// each appearing somewhere in the resume, in unrelated sentences, is not the same as the
// resume demonstrating "project management". A sentence boundary (.!?;\n) is a hard cut;
// within a sentence, ALL significant tokens must additionally fall within a single span
// of PROXIMITY_WINDOW words of each other (a true span check, not anchored on any one
// token) so a long buzzword-list sentence doesn't bridge two unrelated mentions either.
// WINDOW=12 is wide enough for ordinary prose ("owned the project timeline, budget, and
// risk register while reporting to senior management weekly" — 10 words apart) while
// still requiring genuine co-occurrence in one sentence.
const PROXIMITY_WINDOW = 12;

function splitSentences(text: string): string[] {
    return text.split(/[.!?;\n]+/);
}

function sentenceWords(sentence: string): string[] {
    return sentence.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter((w) => w.length > 0);
}

/**
 * True span check: every token in `tokens` must occur somewhere in `words`, and there
 * must exist a choice of one occurrence per token (tokens may repeat) whose positions
 * fit within a single window of `windowSize` words — i.e. (max position - min position)
 * <= windowSize across the whole token span, not measured from any one "anchor" token.
 *
 * Implemented as the classic "smallest range covering at least one element from each of
 * k lists" sweep: merge every (position, tokenIndex) pair, sort by position, then slide
 * a window over the merged list tracking how many distinct tokens are currently covered.
 */
function withinWindow(words: string[], tokens: string[], windowSize: number): boolean {
    const merged: Array<{ pos: number; tokenIdx: number }> = [];
    const tokenSeen = new Array(tokens.length).fill(false);
    words.forEach((w, pos) => {
        const tokenIdx = tokens.indexOf(w);
        if (tokenIdx !== -1) {
            merged.push({ pos, tokenIdx });
            tokenSeen[tokenIdx] = true;
        }
    });
    if (tokenSeen.some((seen) => !seen)) return false; // a token is absent from this sentence
    merged.sort((a, b) => a.pos - b.pos);

    const counts = new Array(tokens.length).fill(0);
    let distinct = 0;
    let left = 0;
    let minSpan = Infinity;
    for (let right = 0; right < merged.length; right++) {
        if (counts[merged[right].tokenIdx] === 0) distinct++;
        counts[merged[right].tokenIdx]++;
        while (distinct === tokens.length) {
            minSpan = Math.min(minSpan, merged[right].pos - merged[left].pos);
            counts[merged[left].tokenIdx]--;
            if (counts[merged[left].tokenIdx] === 0) distinct--;
            left++;
        }
    }
    return minSpan <= windowSize;
}

/** Co-occurrence check for multi-word terms: all tokens present in the SAME sentence, within a bounded window. */
function tokensCoOccur(tokens: string[], resumeLowerText: string, windowSize = PROXIMITY_WINDOW): boolean {
    return splitSentences(resumeLowerText).some((sentence) => withinWindow(sentenceWords(sentence), tokens, windowSize));
}

export function matchTier1(term: string, resumeLowerText: string): boolean {
    const resume = normalizeResume(resumeLowerText);
    const normTerm = normalizeTerm(term);
    if (normTerm.length > 0) {
        // Word-boundary substring (space-padded) — so "go" does NOT match "going" and a
        // 2-char atomic skill ("ML", "QA") matches its own word, not a substring of another.
        if (resume.includes(` ${normTerm} `)) return true;
        const tokens = normTerm.split(' ').filter((t) => t.length >= 3);
        if (tokens.length === 1) {
            if (resume.includes(` ${tokens[0]} `)) return true;
        } else if (tokens.length >= 2 && tokensCoOccur(tokens, resumeLowerText)) {
            return true;
        }
    }
    // Skill-category credit — e.g. "scripting languages" reduces to "languages" and won't
    // match literally, but the resume lists Python/Bash → the language skill IS present.
    return matchSkillCategory(term.toLowerCase(), resume);
}

/**
 * Guard for the dropped-short-token case: when a multi-word term has a short
 * (<3-char) token filtered out by the significant-token cut — e.g. "AI Automation"
 * -> {automation} once "ai" is dropped, "UX Reporting" -> {reporting} once "ux" is
 * dropped — the surviving single token is NOT a discriminating match on its own: it's
 * whatever generic noun happened to be left after the acronym vanished. A bare ratio
 * match on that one word would credit against ANY string containing it (e.g. "Data
 * Automation Pipelines"), regardless of which noun it is — no fixed word list can
 * enumerate every generic noun, so this generalises instead of allowlisting them.
 *
 * Triggers whenever the smaller side's SIGNIFICANT-token set collapses to exactly one
 * token AND the term originally had >= 2 tokens after qualifier stripping (i.e. a
 * token was lost specifically to the <3-char cut, not because the term was always a
 * single word — a genuinely single-word term like "alerting" must still bridge via the
 * ratio rule below). When it triggers, require the smaller side's FULL normalized
 * phrase (including the short, filtered-out token) to appear as a substring in the
 * other side's phrase. Returns `null` when the guard doesn't apply (caller falls back
 * to the ratio rule).
 */
function droppedShortTokenGuard(
    smaller: Set<string>,
    smallerRaw: string,
    otherRaw: string,
): boolean | null {
    if (smaller.size !== 1) return null;
    const smallerFullPhrase = normalizeTerm(smallerRaw);
    const rawTokenCount = smallerFullPhrase.length > 0 ? smallerFullPhrase.split(' ').length : 0;
    if (rawTokenCount < 2) return null; // term was always a single word — no token was dropped
    const otherFullPhrase = normalizeTerm(otherRaw);
    return smallerFullPhrase.length > 0 && otherFullPhrase.includes(smallerFullPhrase);
}

/**
 * Significant-token overlap — bridges differently-phrased competencies.
 *
 * "Critical thinking and root cause analysis" vs "...root-cause analysis" → shares
 * {root,cause,analysis}. Reuses `normalizeTerm` (strips qualifier/suffix noise), then
 * compares the sets of significant (≥3-char) tokens.
 *
 * Matches when ≥ `minShared` tokens overlap OR ≥ 60% of the smaller token set overlaps
 * (so a short, fully-contained phrase like "alerting" vs "alerting dashboards" bridges),
 * subject to the dropped-short-token guard above.
 */
export function tokenOverlapMatch(a: string, b: string, minShared = 2): boolean {
    const toks = (s: string) => new Set(normalizeTerm(s).split(' ').filter((t) => t.length >= 3));
    const A = toks(a), B = toks(b);
    if (A.size === 0 || B.size === 0) return false;
    let shared = 0;
    for (const t of A) if (B.has(t)) shared++;
    if (shared >= minShared) return true;

    const [smaller, smallerRaw, otherRaw] = A.size <= B.size ? [A, a, b] : [B, b, a];
    const guarded = droppedShortTokenGuard(smaller, smallerRaw, otherRaw);
    if (guarded !== null) return guarded;

    // match if ≥ 60% of the smaller set overlaps
    return shared / Math.min(A.size, B.size) >= 0.6;
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

/** All surface forms for a canonical: its display form (underscores→spaces) + every alias. */
export function surfaceFormsFor(canonical: string, reverseMap: Map<string, string[]>): Set<string> {
    return new Set([canonical.replaceAll('_', ' '), ...(reverseMap.get(canonical) ?? [])]);
}

/**
 * True when a space-padded, lowercased-alnum haystack mentions any surface form of
 * `canonical` as a whole word. Shared by the tech-transfer tier and the
 * vendor-provenance guard so both resolve canonicals identically.
 */
export function mentionsCanonical(canonical: string, paddedHaystack: string, reverseMap: Map<string, string[]>): boolean {
    for (const form of surfaceFormsFor(canonical, reverseMap)) {
        const norm = normalizeTerm(form);
        if (norm.length > 0 && paddedHaystack.includes(` ${norm} `)) return true;
    }
    return false;
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
    const jdCanonical = aliasMap.get(termLower) ?? normalizeTerm(term).replaceAll(' ', '_');

    const reverseMap = buildReverseAliasMap(aliasMap);
    const resume = normalizeResume(resumeLowerText);

    for (const group of techGroups) {
        if (!group.includes(jdCanonical)) continue;
        // Found a group containing this JD term; check the siblings' surface forms.
        for (const sibling of group) {
            if (sibling === jdCanonical) continue;
            if (mentionsCanonical(sibling, resume, reverseMap)) return true;
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
