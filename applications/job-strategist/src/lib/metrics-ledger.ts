/**
 * @format
 * Grounded-metrics ledger — the SUPPLY side of the metric honesty loop.
 *
 * The writer persona demands impact metrics but its evidence blocks clip
 * case-study prose at 220 chars and compress KB passages to one-line
 * citations, so measured numbers rarely reach it — and a metric-hungry
 * prompt with no grounded numbers is exactly the condition under which the
 * 2026-07-08 run lifted "8 minutes to 30 seconds" from the persona's own
 * example. This module extracts number-bearing sentences VERBATIM (no LLM,
 * no clip) from the candidate's case-study rows into a dedicated block the
 * writer may draw from; the same text feeds the allowed-number sets, so the
 * provenance guards enforce rather than fight it.
 */
import type { Pool } from 'pg';
import type { StructuredResumeData } from '@bedrock/shared';

/** ISO dates masked before scanning so 2026-07-04 never reads as three numbers. */
const ISO_DATE = /\b\d{4}-\d{2}-\d{2}\b/g;
/** A standalone calendar year — not a metric on its own. */
const BARE_YEAR = /^(?:19|20)\d{2}$/;
/** Number tokens, including comma-grouped counts (17,138) and decimals (2.2). */
const NUMBER_TOKEN = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g;
/**
 * A number with a measurement unit — the impact-metric shape the presence
 * gate looks for. Deliberately excludes tenure units (years/months): "3 years
 * of experience" is a tenure claim, not an impact metric.
 */
const UNIT_METRIC =
    /(?:\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(?:%|x\b|×|ms\b|seconds?\b|secs?\b|minutes?\b|mins?\b|hours?\b|hrs?\b|days?\b|weeks?\b)/i;

/** Does this sentence carry a metric-grade number (not just a year or date)? */
function hasMetricNumber(sentence: string): boolean {
    const masked = sentence.replace(ISO_DATE, ' ');
    const tokens = masked.match(NUMBER_TOKEN) ?? [];
    return tokens.some((t) => !BARE_YEAR.test(t));
}

/**
 * The number-bearing sentences of a prose blob, verbatim. Sentence-split on
 * terminal punctuation + newlines; bare years and ISO dates alone do not
 * qualify a sentence.
 */
export function extractMetricSentences(text: string): string[] {
    return text
        .split(/(?<=[.!?])\s+|\n+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0 && hasMetricNumber(s));
}

/** One attributable source row: project name + the prose to mine. */
export interface MetricSourceRow {
    readonly project: string;
    readonly text: string;
}

const LEDGER_HEADER =
    '### GROUNDED METRICS (measured numbers from the candidate\'s own documented work — ' +
    'the ONLY measured numbers the resume may use; surface the JD-relevant ones with their ' +
    'context, keeping each value EXACTLY as stated)';

/**
 * Format the ledger block for the writer prompt: one `- [project] sentence`
 * line per metric sentence, capped. '' when nothing qualifies (section is
 * omitted entirely so the persona's no-supply fallback applies).
 */
export function formatMetricsLedger(rows: ReadonlyArray<MetricSourceRow>, maxLines = 24): string {
    const lines: string[] = [];
    for (const row of rows) {
        for (const sentence of extractMetricSentences(row.text)) {
            lines.push(`- [${row.project}] ${sentence}`);
            if (lines.length >= maxLines) break;
        }
        if (lines.length >= maxLines) break;
    }
    if (lines.length === 0) return '';
    return [LEDGER_HEADER, ...lines].join('\n');
}

/**
 * Does the resume surface ANY impact metric (unit-bearing number) in its
 * summary, experience highlights, or key achievements? Bare years, periods
 * and tenure claims do not count — this gates the metric-surfacing rewrite,
 * which should fire only when the writer shipped a number-free resume while
 * grounded metrics were available.
 */
export function resumeHasMetric(resume: StructuredResumeData): boolean {
    const texts = [
        resume.summary,
        ...resume.experience.flatMap((e) => e.highlights),
        ...resume.keyAchievements.map((a) => a.achievement),
    ];
    return texts.some((t) => UNIT_METRIC.test(t.replace(ISO_DATE, ' ')));
}

/**
 * Load the candidate's grounded-metrics ledger from the case-study tables —
 * FULL row text (highlights, decisions, challenges), project-attributed,
 * deterministic. Fail-open to '' (a missing ledger must never block a run).
 */
export async function loadGroundedMetricsLedger(pool: Pool, userId: string): Promise<string> {
    try {
        const { rows } = await pool.query<{ project: string; text: string }>(
            `SELECT p.name AS project, h.title || '. ' || h.description AS text
               FROM project_highlights h JOIN projects p ON p.id = h.project_id
              WHERE h.user_id = $1
              UNION ALL
             SELECT p.name, d.decision || '. ' || d.consequences
               FROM project_decisions d JOIN projects p ON p.id = d.project_id
              WHERE d.user_id = $1
              UNION ALL
             SELECT p.name, c.problem || '. ' || c.solution
               FROM project_challenges c JOIN projects p ON p.id = c.project_id
              WHERE c.user_id = $1`,
            [userId],
        );
        return formatMetricsLedger(rows);
    } catch {
        return '';
    }
}

/**
 * Merge the case-study ledger with the research agent's KB pass-through
 * sentences into ONE writer-facing block. KB sentences are re-checked for a
 * metric-grade number (matcher drift tolerance) and attributed as [KB].
 */
export function composeMetricsBlock(ledger: string, kbSentences?: ReadonlyArray<string>): string {
    const kbLines = (kbSentences ?? [])
        .map((s) => s.trim())
        .filter((s) => s.length > 0 && extractMetricSentences(s).length > 0)
        .map((s) => `- [KB] ${s}`);
    if (ledger && kbLines.length === 0) return ledger;
    if (!ledger && kbLines.length === 0) return '';
    if (!ledger) return [LEDGER_HEADER, ...kbLines].join('\n');
    return [ledger, ...kbLines].join('\n');
}
