/**
 * @format
 * Text primitives shared by the resume-guard rule modules — tokenisers,
 * name-variant expansion, and sentence splitting. Pure functions, no rules.
 */

/** Sentence boundary used by every prose-level rule. */
export const SENTENCE_SPLIT = /(?<=[.!?])\s+/;

/** Numbers (integers with optional +) appearing in a prose string. */
export function numbersIn(text: string): Set<string> {
    return new Set((text.match(/\d+(?:[.,]\d+)?\+?/g) ?? []).map((n) => n.replace(/[,+]/g, '')));
}

export const ECHO_STOPWORDS = new Set([
    'production', 'platform', 'platforms', 'systems', 'infrastructure', 'engineering', 'delivery',
    'through', 'across', 'every', 'before', 'spanning', 'applies', 'builds', 'build', 'built',
    'and', 'the', 'via', 'end', 'with', 'for', 'from', 'that', 'this', 'into', 'are', 'has',
    'have', 'was', 'were', 'per', 'all', 'one', 'two', 'its', 'our', 'their', 'work', 'using',
]);

/** Content tokens (len >= 3 so tech acronyms like EKS/CDK/IaC count; non-generic). */
export function contentTokens(text: string): string[] {
    return (text.toLowerCase().match(/[a-z][a-z0-9+-]{2,}/g) ?? []).filter((t) => !ECHO_STOPWORDS.has(t));
}

/** Adjacent content-token pairs — phrase-level fingerprint of a text. */
export function contentBigrams(text: string): Set<string> {
    const tokens = contentTokens(text);
    const out = new Set<string>();
    for (let i = 0; i < tokens.length - 1; i += 1) out.add(`${tokens[i]} ${tokens[i + 1]}`);
    return out;
}

/** Prose name variants for an entity ("Amazon Web Services (AWS)" → both forms; "Meta via Accenture" → each employer). */
export function nameVariants(name: string): string[] {
    const inner: string[] = [];
    let outer = '';
    let depth = 0;
    let buf = '';
    for (const ch of name) {
        if (ch === '(') { depth += 1; buf = ''; continue; }
        if (ch === ')' && depth > 0) { depth -= 1; inner.push(buf); outer += ' '; continue; }
        if (depth > 0) buf += ch; else outer += ch;
    }
    const collapsed = outer.toLowerCase().replaceAll(/\s+/g, ' ');
    const raw = [...collapsed.split(' via '), ...inner].map((v) => v.trim().toLowerCase());
    // "The Mater Private Network" must match "Mater Private Network's" in prose.
    const dearticled = raw.filter((v) => v.startsWith('the ')).map((v) => v.slice(4));
    return [...raw, ...dearticled].filter((v) => v.length >= 3);
}

export function escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/** Whole-word presence of any variant in the sentence. */
export function anyVariantIn(sentence: string, variants: string[]): boolean {
    return variants.some((v) => new RegExp(String.raw`\b${escapeRe(v)}\b`, 'i').test(sentence));
}

/** Role-generic words that overlap in ANY two tech-job descriptions — they
 *  must not count as grounding evidence. */
export const GENERIC_EXPERIENCE_WORDS = new Set([
    'engineering', 'operations', 'teams', 'systems', 'platform', 'platforms',
    'infrastructure', 'technical', 'support', 'across', 'working', 'worked',
    'procedures', 'processes', 'process', 'quality', 'assurance', 'analyst',
    'documentation', 'workflows', 'standardised', 'standardized', 'collaborated',
]);

export function distinctiveTokens(text: string): Set<string> {
    const out = new Set<string>();
    for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
        if (raw.length >= 5 && !GENERIC_EXPERIENCE_WORDS.has(raw)) out.add(raw);
    }
    return out;
}

/** Light suffix stem so word forms match across texts (deployments/deployed -> deploy). */
export function stemToken(t: string): string {
    return t.replace(/ments?$/, '').replace(/ings?$/, '').replace(/ed$/, '').replace(/s$/, '');
}

/** Stemmed distinctive tokens of a text (length/stoplist filtered first). */
export function stemmedTokens(text: string): Set<string> {
    return new Set([...distinctiveTokens(text)].map(stemToken));
}
