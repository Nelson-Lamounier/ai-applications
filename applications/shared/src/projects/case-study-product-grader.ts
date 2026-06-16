/**
 * @format
 * Deterministic graders for the case-study PRODUCT-FRAMING contract (CLAUDE.md §5).
 *
 * The case-study prompt was changed to lead with the product (what it is / who
 * it's for / the problem it solves) before the engineering, fed by a ground-truth
 * <productContext> block. These graders encode that promise as string checks —
 * no LLM call — so they run in CI on every prompt change AND can grade a live
 * agent run's output:
 *
 *   - taglineIsProductFirst : the tagline names the product/value, not a tech list.
 *   - pitchOpensWithProduct : the first pitch paragraph carries product purpose
 *                             (overlaps productContext when one is supplied), not
 *                             an infrastructure opener.
 *   - noInfraOpener         : the pitch's first sentence does not open with the
 *                             classic "platform spanning N repositories…" failure.
 *
 * When no productContext is supplied the grounding check is a no-op pass — we
 * cannot assert product framing against a source that does not exist.
 */

export interface ProductGradeInput {
    /** The ground-truth product context fed to the agent (null when none existed). */
    readonly productContext: string | null;
    /** The agent's emitted tagline + pitch. */
    readonly tagline: string;
    readonly pitch: string;
}

export interface ProductGradeResult {
    readonly grader: string;
    readonly pass: boolean;
    readonly score: number; // 0..1
    readonly failures: readonly string[];
}

export interface ProductGradeReport {
    readonly pass: boolean;
    readonly results: readonly ProductGradeResult[];
}

const mk = (grader: string, failures: string[], score?: number): ProductGradeResult => ({
    grader,
    pass: failures.length === 0,
    score: score ?? (failures.length === 0 ? 1 : 0),
    failures,
});

/** Tech/infra tokens that read as "how it's built", never "what it is". */
const TECH_TOKENS: ReadonlySet<string> = new Set([
    'kubernetes', 'k8s', 'aws', 'cdk', 'eks', 'postgres', 'aurora', 'pgvector',
    'redis', 'pinecone', 'bedrock', 'argocd', 'argo', 'terraform', 'helm',
    'prometheus', 'grafana', 'loki', 'tempo', 'pyroscope', 'karpenter', 'waf',
    'cloudfront', 'lambda', 'typescript', 'react', 'nextjs', 'fastify',
    'microservices', 'microservice', 'monorepo', 'repositories', 'repository',
    'repos', 'titan', 'rag', 'gitops', 'observability', 'pipeline', 'infrastructure',
]);

const STOPWORDS: ReadonlySet<string> = new Set([
    'the', 'and', 'that', 'with', 'for', 'this', 'from', 'into', 'across', 'their',
    'have', 'has', 'are', 'was', 'were', 'built', 'build', 'designed', 'platform',
    'production', 'spanning', 'four', 'three', 'multiple', 'system', 'application',
    'applications', 'app', 'using', 'via', 'through', 'over', 'which', 'they',
]);

const words = (s: string): string[] =>
    s.toLowerCase().match(/[a-z0-9+]+/g) ?? [];

const significant = (s: string): string[] =>
    words(s).filter((w) => w.length > 3 && !STOPWORDS.has(w) && !TECH_TOKENS.has(w));

/** First paragraph of a pitch (split on blank line; falls back to the head). */
function firstParagraph(pitch: string): string {
    const para = pitch.split(/\n\s*\n/)[0]?.trim() ?? '';
    return para.length > 0 ? para : pitch.slice(0, 400);
}

/** First sentence of a string. */
function firstSentence(text: string): string {
    return (text.split(/[.!?]/)[0] ?? text).trim();
}

/**
 * Tagline must name the product/value, not be a tech-stack roll-call. Fails when
 * more than half its content words are tech tokens or it carries no product noun.
 */
export function gradeTaglineIsProductFirst(input: ProductGradeInput): ProductGradeResult {
    const failures: string[] = [];
    const ws = words(input.tagline).filter((w) => w.length > 2 && !STOPWORDS.has(w));
    if (ws.length === 0) {
        failures.push('tagline has no content words');
        return mk('taglineIsProductFirst', failures);
    }
    const tech = ws.filter((w) => TECH_TOKENS.has(w)).length;
    if (tech / ws.length > 0.5) {
        failures.push(`tagline is tech-dominated (${tech}/${ws.length} tech tokens) — say what the product is`);
    }
    if (significant(input.tagline).length === 0) {
        failures.push('tagline carries no product/value words (all tech or filler)');
    }
    return mk('taglineIsProductFirst', failures);
}

/**
 * The first pitch paragraph must carry product purpose. When productContext is
 * supplied it must share ≥2 significant (non-tech) words with it — proof the
 * pitch actually used the product framing rather than diving into internals.
 */
export function gradePitchOpensWithProduct(input: ProductGradeInput): ProductGradeResult {
    if (!input.productContext || input.productContext.trim().length === 0) {
        return mk('pitchOpensWithProduct', [], 1); // no source to ground against
    }
    const para = significant(firstParagraph(input.pitch));
    const ctx = new Set(significant(input.productContext));
    const overlap = new Set(para.filter((w) => ctx.has(w)));
    if (overlap.size < 2) {
        return mk('pitchOpensWithProduct', [
            `first pitch paragraph shares only ${overlap.size} product word(s) with productContext — it should open with what the product does`,
        ]);
    }
    return mk('pitchOpensWithProduct', []);
}

/** The classic failure: opening on infrastructure scope instead of the product. */
const INFRA_OPENER = /\b(platform spanning|spanning (four|three|multiple|several|\d+)\s+(repositor|repos)|monorepo|\d+\s+(micro)?services|production saas platform spanning)\b/;

/**
 * The pitch's first sentence must not open with an infrastructure boast. Soft
 * (score 0.5) — it's a strong smell, not a structural violation.
 */
export function gradeNoInfraOpener(input: ProductGradeInput): ProductGradeResult {
    const opener = firstSentence(firstParagraph(input.pitch)).toLowerCase();
    if (INFRA_OPENER.test(opener)) {
        return mk('noInfraOpener', [
            'pitch opens on infrastructure scope ("platform spanning N repositories…") instead of the product',
        ], 0.5);
    }
    return mk('noInfraOpener', []);
}

const PRODUCT_GRADERS: ReadonlyArray<(i: ProductGradeInput) => ProductGradeResult> = [
    gradeTaglineIsProductFirst,
    gradePitchOpensWithProduct,
    gradeNoInfraOpener,
];

/** Run every product-framing grader; overall pass = all pass. */
export function gradeProductFraming(input: ProductGradeInput): ProductGradeReport {
    const results = PRODUCT_GRADERS.map((g) => g(input));
    return { pass: results.every((r) => r.pass), results };
}
