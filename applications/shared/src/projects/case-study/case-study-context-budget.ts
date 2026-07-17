/**
 * @format
 * case-study-context-budget — bound a CaseStudyContext to a token ceiling.
 *
 * The case-study agent serialises the entire CaseStudyContext as JSON into a
 * single user message. For a multi_repo project (2+ repos × up to 50 commits
 * + 24 KB chunks, with unbounded per-item text) that prompt reached ~213k
 * input tokens — near Sonnet's ~200k context window — which then pushed the
 * model past its output cap (stopReason='max_tokens') and failed the run.
 *
 * `packContext` makes the prompt size predictable:
 *   1. Truncate each commit message / KB chunk / PR body to a per-item char cap.
 *   2. Greedily keep items in their incoming order (the loader already sorts
 *      commits + PRs newest-first) until a global estimated-token ceiling is
 *      reached; drop the remainder.
 *
 * Project/component/repository metadata is always preserved — it is small,
 * bounded, and structurally required by the prompt. Only the unbounded
 * evidence lists (commits, pulls, kbChunks) are subject to the budget.
 *
 * Token estimation uses the standard ~4-chars-per-token heuristic. It only
 * needs to be good enough to keep us comfortably under the window with output
 * headroom; it is intentionally an over-estimate-friendly approximation, not
 * a real tokenizer.
 */
import type { CaseStudyContext } from './case-study-types.js';

/** Approx chars-per-token for English + code + JSON punctuation. */
const CHARS_PER_TOKEN = 4;

export interface PackContextOptions {
    /** Global ceiling for the serialised context, in estimated tokens. */
    readonly maxTokens: number;
    /** Max chars kept per commit message. Default 800. */
    readonly maxCommitMessageChars?: number;
    /** Max chars kept per KB chunk. Default 2400. */
    readonly maxKbChunkChars?: number;
    /** Max chars kept per PR body. Default 1200. */
    readonly maxPullBodyChars?: number;
    /**
     * Hard cap on commits BEFORE budget packing (newest-first, so the cap
     * keeps the most recent). Commits are the bulk-noise lane — up to 500/repo
     * × 800 chars from ingestion — and were measured filling most of the
     * budget on the live frontend-portfolio project (84K→131K input tokens
     * per regenerate). Default 150.
     */
    readonly maxCommits?: number;
}

const DEFAULT_COMMIT_MESSAGE_CHARS = 800;
const DEFAULT_KB_CHUNK_CHARS = 2_400;
const DEFAULT_PULL_BODY_CHARS = 1_200;
const DEFAULT_MAX_COMMITS = 150;

/** Estimate the token count of a string via the chars-per-token heuristic. */
export function estimateTokens(text: string): number {
    return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Truncate to at most `max` chars, appending an ellipsis marker when cut. */
function clamp(text: string, max: number): string {
    if (text.length <= max) return text;
    // Reserve room for the marker so the result never exceeds `max`.
    const marker = '…';
    return text.slice(0, Math.max(0, max - marker.length)) + marker;
}

/** Greedily keep items (in order) while their serialised cost fits the budget. */
function takeWithinBudget<T>(items: readonly T[], budget: number): { kept: T[]; remaining: number } {
    const kept: T[] = [];
    let remaining = budget;
    for (const item of items) {
        const cost = estimateTokens(JSON.stringify(item));
        if (cost > remaining) break;
        kept.push(item);
        remaining -= cost;
    }
    return { kept, remaining };
}

/**
 * Bound `context` to `opts.maxTokens` estimated tokens.
 *
 * Pure + deterministic: same input + options always yields identical output.
 * Items are kept in their incoming order, so callers control priority by
 * pre-sorting (the loader sorts commits + pulls newest-first).
 */
export function packContext(context: CaseStudyContext, opts: PackContextOptions): CaseStudyContext {
    const commitMsgCap = opts.maxCommitMessageChars ?? DEFAULT_COMMIT_MESSAGE_CHARS;
    const kbChunkCap   = opts.maxKbChunkChars ?? DEFAULT_KB_CHUNK_CHARS;
    const pullBodyCap  = opts.maxPullBodyChars ?? DEFAULT_PULL_BODY_CHARS;
    const commitCap    = opts.maxCommits ?? DEFAULT_MAX_COMMITS;

    // 1. Per-item truncation (does not change list lengths) + the commit
    //    pre-cap (loader sorts newest-first, so the cap keeps recent work).
    const commits = context.commits.slice(0, commitCap).map((c) => ({ ...c, message: clamp(c.message, commitMsgCap) }));
    const pulls   = context.pulls.map((p) => ({ ...p, body: p.body == null ? p.body : clamp(p.body, pullBodyCap) }));
    const kbChunks = context.kbChunks.map((k) => ({ ...k, content: clamp(k.content, kbChunkCap) }));

    // 2. Fixed cost — metadata that is always preserved. Compute the budget
    //    remaining for the evidence lists after the skeleton is accounted for.
    const skeleton: CaseStudyContext = {
        ...context,
        commits:  [],
        pulls:    [],
        kbChunks: [],
    };
    const skeletonTokens = estimateTokens(JSON.stringify(skeleton));

    // 3. Greedy fill in priority order: PRs FIRST (the system prompt calls
    //    them the strongest form of evidence — under the old commits-first
    //    order they were the first evidence silently dropped on commit-heavy
    //    projects), then KB chunks (narrative context), then commits (bulk,
    //    pre-capped above). Each item costs its serialised size.
    const pullsFill   = takeWithinBudget(pulls, opts.maxTokens - skeletonTokens);
    const kbFill      = takeWithinBudget(kbChunks, pullsFill.remaining);
    const commitsFill = takeWithinBudget(commits, kbFill.remaining);

    return {
        ...context,
        commits:  commitsFill.kept,
        kbChunks: kbFill.kept,
        pulls:    pullsFill.kept,
    };
}
