/**
 * @format
 * Pure scoring for the article-pipeline RESEARCH-phase golden eval. No I/O.
 *
 * The eval answers CLAUDE.md rule 5 for the research phase: "correct grounding
 * to evidence". It asserts that the SAME pgvector retrieval the research agent
 * runs in production (mode-aware depth over the user KB) surfaces passages from
 * the repos a given article prompt is actually about.
 *
 * The runner (run-article-eval.ts) supplies the real retrieved repo list per
 * golden query; this module computes repo-recall, leakage, and aggregates.
 * Tool-agnostic and deterministic — no LLM judge, so it is cheap enough to run
 * on every prompt or retrieval change.
 */

import type { PipelineMode } from '@bedrock/shared';

export interface GoldenArticleQuery {
    readonly id: string;
    /** The article draft/prompt text fed to retrieval (as the research agent would). */
    readonly prompt: string;
    /** Which retrieval depth profile to exercise (short prompt ⇒ 'kb-augmented'). */
    readonly mode: PipelineMode;
    /**
     * Repos (owner/name) the prompt is genuinely about. Positives expect these
     * surfaced; negatives expect them ABSENT (the prompt is off-topic for the KB).
     */
    readonly expectedRepos: string[];
    readonly kind: 'positive' | 'negative';
}

export interface ArticleQueryResult {
    readonly id: string;
    readonly kind: 'positive' | 'negative';
    /** Fraction of expectedRepos surfaced in the retrieved passages (0..1). */
    readonly repoRecall: number;
    /** Distinct repos surfaced, in score order. */
    readonly retrievedRepos: string[];
    readonly retrievedCount: number;
}

export interface ArticleEvalReport {
    readonly queryCount: number;
    readonly positiveCount: number;
    readonly negativeCount: number;
    /** Mean repo-recall over positives — higher is better. */
    readonly meanRecallPositive: number;
    /**
     * Mean repo-recall over negatives — LOWER is better. A non-zero value means
     * an off-topic prompt is pulling in repos it should not (retrieval leakage).
     */
    readonly meanRecallNegative: number;
    readonly perQuery: ReadonlyArray<ArticleQueryResult>;
}

/** Case-insensitive "owner/name appears in this retrieved source" test. */
function repoMatches(expected: string, retrieved: string): boolean {
    return retrieved.toLowerCase().includes(expected.toLowerCase());
}

/**
 * Fraction of a query's expectedRepos that appear anywhere in the retrieved repo
 * list. Returns 0 when nothing is expected (keeps negatives well-defined).
 */
export function repoRecall(retrievedRepos: ReadonlyArray<string>, expectedRepos: ReadonlyArray<string>): number {
    if (expectedRepos.length === 0) return 0;
    const found = expectedRepos.filter((e) => retrievedRepos.some((r) => repoMatches(e, r)));
    return found.length / expectedRepos.length;
}

/** De-duplicate repos while preserving first-seen (score) order. */
export function distinctReposInOrder(repos: ReadonlyArray<string>): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const r of repos) {
        const key = r.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(r);
    }
    return out;
}

const mean = (xs: ReadonlyArray<number>): number =>
    xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

export function aggregate(results: ReadonlyArray<ArticleQueryResult>): ArticleEvalReport {
    const positives = results.filter((r) => r.kind === 'positive');
    const negatives = results.filter((r) => r.kind === 'negative');
    return {
        queryCount:         results.length,
        positiveCount:      positives.length,
        negativeCount:      negatives.length,
        meanRecallPositive: mean(positives.map((r) => r.repoRecall)),
        meanRecallNegative: mean(negatives.map((r) => r.repoRecall)),
        perQuery:           results,
    };
}

/**
 * Pass/fail gate. The research phase grounds correctly when positives clear the
 * recall floor AND negatives stay below the leakage ceiling.
 */
export function passesGate(
    report: ArticleEvalReport,
    minRecallPositive: number,
    maxRecallNegative: number,
): boolean {
    return report.meanRecallPositive >= minRecallPositive
        && report.meanRecallNegative <= maxRecallNegative;
}

/** Markdown summary for the console / CI log. */
export function formatReport(report: ArticleEvalReport): string {
    const pct = (n: number): string => `${(n * 100).toFixed(0)}%`;
    const rows = report.perQuery.map((r) =>
        `| ${r.id} | ${r.kind} | ${pct(r.repoRecall)} | ${r.retrievedCount} | ${r.retrievedRepos.join(', ') || '—'} |`,
    );
    return [
        `Article research-phase eval — ${report.queryCount} queries (${report.positiveCount} pos / ${report.negativeCount} neg)`,
        `mean repo-recall: pos↑ ${pct(report.meanRecallPositive)} · neg↓ ${pct(report.meanRecallNegative)}`,
        '',
        '| query | kind | repo-recall | hits | retrieved repos |',
        '| --- | --- | --- | --- | --- |',
        ...rows,
    ].join('\n');
}
