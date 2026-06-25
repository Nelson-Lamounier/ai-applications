/**
 * @format
 * Pure WRITER-phase quality checks. No I/O, no Bedrock — deterministic enough to
 * run in jest (CI) on fixtures AND to grade live writer output in the gated
 * runner (run-writer-eval.ts).
 *
 * These encode the writer phase's focus per CLAUDE.md rule 5: valid structured
 * output, correct phase focus (the outline is actually covered), British-English
 * house style, honest references (no "used inline" link that is absent), and a
 * plausible reading time. They are signals a deterministic checker can verify
 * without a judge; semantic faithfulness is left to the grounding verifier.
 */
import type { ArticleMetadata, OutlineSection, WriterResult } from '@bedrock/shared';

// ── Prose extraction ─────────────────────────────────────────────────────────
// Spelling/coverage checks must read PROSE only. Fenced code, inline code and
// JSX component tags legitimately carry US-spelled API names (Color, optimize,
// normalize) and must not trip the British-English check.

export function stripNonProse(mdx: string): string {
    return mdx
        .replace(/```[\s\S]*?```/g, ' ')      // fenced code blocks
        .replace(/`[^`]*`/g, ' ')              // inline code
        .replace(/<[^>]+>/g, ' ')              // JSX / HTML tags
        .replace(/^---[\s\S]*?---/, ' ');      // leading frontmatter block
}

// ── British-English house style ──────────────────────────────────────────────
// Conservative, high-confidence US→UK pairs only — each unlikely to be a false
// positive in technical prose once code is stripped. Word-boundary matched,
// case-insensitive.
const US_SPELLING_PATTERNS: ReadonlyArray<{ us: RegExp; uk: string }> = [
    { us: /\bcolor(s|ed|ing)?\b/gi,            uk: 'colour' },
    { us: /\bbehavior(s|al)?\b/gi,             uk: 'behaviour' },
    { us: /\boptimiz(e|es|ed|ing|ation)\b/gi,  uk: 'optimise' },
    { us: /\borganiz(e|es|ed|ing|ation)\b/gi,  uk: 'organise' },
    { us: /\bcenter(s|ed|ing)?\b/gi,           uk: 'centre' },
    { us: /\bcatalog(s|ed|ing)?\b/gi,          uk: 'catalogue' },
    { us: /\bprioritiz(e|es|ed|ing|ation)\b/gi, uk: 'prioritise' },
    { us: /\bmodeled\b/gi,                     uk: 'modelled' },
    { us: /\blabeled\b/gi,                     uk: 'labelled' },
];

/** Distinct US spellings found in the prose, each reported as "us→uk". */
export function britishEnglishViolations(mdx: string): string[] {
    const prose = stripNonProse(mdx);
    const hits = new Set<string>();
    for (const { us, uk } of US_SPELLING_PATTERNS) {
        const matches = prose.match(us);
        if (matches) for (const m of matches) hits.add(`${m.toLowerCase()}→${uk}`);
    }
    return [...hits];
}

// ── Outline coverage ─────────────────────────────────────────────────────────

export interface OutlineCoverage {
    readonly ratio: number;
    readonly missing: string[];
}

/** Fraction of outline headings whose text appears in the article body. */
export function outlineCoverage(mdx: string, outline: ReadonlyArray<OutlineSection>): OutlineCoverage {
    if (outline.length === 0) return { ratio: 1, missing: [] };
    const haystack = mdx.toLowerCase();
    const missing = outline
        .map((s) => s.heading)
        .filter((h) => !haystack.includes(h.toLowerCase().trim()));
    return { ratio: (outline.length - missing.length) / outline.length, missing };
}

// ── Reference honesty ────────────────────────────────────────────────────────

/** References flagged usedInline=true whose URL is NOT actually in the content. */
export function inlineReferenceViolations(result: WriterResult): string[] {
    const content = result.content;
    return (result.suggestedReferences ?? [])
        .filter((r) => r.usedInline && !content.includes(r.url))
        .map((r) => r.url);
}

// ── Reading time plausibility ────────────────────────────────────────────────

/** True when stated readingTime is within `tolerance` (ratio) of words/200. */
export function readingTimePlausible(metadata: ArticleMetadata, mdx: string, tolerance = 0.6): boolean {
    const words = stripNonProse(mdx).split(/\s+/).filter(Boolean).length;
    const estimate = Math.max(1, words / 200);
    if (metadata.readingTime <= 0) return false;
    const lo = estimate * (1 - tolerance);
    const hi = estimate * (1 + tolerance) + 1; // +1 absorbs rounding on short drafts
    return metadata.readingTime >= lo && metadata.readingTime <= hi;
}

// ── Aggregate writer-phase grade ─────────────────────────────────────────────

export interface WriterCheck {
    readonly name: string;
    readonly passed: boolean;
    readonly detail: string;
}

export interface WriterCheckReport {
    readonly id: string;
    readonly checks: WriterCheck[];
    readonly passedCount: number;
    readonly total: number;
    /** All checks passed. */
    readonly ok: boolean;
}

export function evaluateWriterOutput(
    id: string,
    result: WriterResult,
    outline: ReadonlyArray<OutlineSection>,
): WriterCheckReport {
    const coverage   = outlineCoverage(result.content, outline);
    const ukViol     = britishEnglishViolations(result.content);
    const refViol    = inlineReferenceViolations(result);
    const checks: WriterCheck[] = [
        { name: 'non-empty-content', passed: result.content.trim().length > 0, detail: `${result.content.length} chars` },
        { name: 'outline-coverage',  passed: coverage.ratio >= 0.8,            detail: `${(coverage.ratio * 100).toFixed(0)}% (missing: ${coverage.missing.join(', ') || 'none'})` },
        { name: 'british-english',   passed: ukViol.length === 0,              detail: ukViol.join(', ') || 'clean' },
        { name: 'inline-references',  passed: refViol.length === 0,            detail: refViol.join(', ') || 'consistent' },
        { name: 'reading-time',      passed: readingTimePlausible(result.metadata, result.content), detail: `${result.metadata.readingTime} min stated` },
        { name: 'metadata-slug',     passed: /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(result.metadata.slug), detail: result.metadata.slug },
    ];
    const passedCount = checks.filter((c) => c.passed).length;
    return { id, checks, passedCount, total: checks.length, ok: passedCount === checks.length };
}

export function formatWriterReports(reports: ReadonlyArray<WriterCheckReport>): string {
    const lines = reports.flatMap((r) => [
        `### ${r.id} — ${r.passedCount}/${r.total} ${r.ok ? '✓' : '✗'}`,
        ...r.checks.map((c) => `  ${c.passed ? '✓' : '✗'} ${c.name}: ${c.detail}`),
    ]);
    const okCount = reports.filter((r) => r.ok).length;
    return [`Writer-phase eval — ${okCount}/${reports.length} briefs fully clean`, '', ...lines].join('\n');
}
