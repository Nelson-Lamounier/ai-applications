/**
 * @format
 * change-impact-grounding — the anti-fabrication gate for change-impact narration.
 *
 * Enforces the grounding contract: an LLM may narrate a {@link ChangeImpactReport}
 * but may NOT introduce a number that isn't a computed/measured fact in it. Given
 * the report, `allowedNumbersFor` is the exact set of citable figures; any number
 * in the narration outside that set (beyond display-rounding tolerance) is
 * fabricated and must be flagged/stripped before the text is served.
 *
 * Pure — no I/O, no LLM. Used to gate the inc-3b narration agent's output and as
 * the assertion in its per-phase eval.
 */

import type { ChangeImpactReport } from './change-metrics.js';

/** Numbers the narration may cite — the report's facts plus their magnitudes. */
export function allowedNumbersFor(report: ChangeImpactReport): Set<number> {
    const allowed = new Set<number>();
    const add = (n: number): void => {
        if (Number.isFinite(n)) { allowed.add(n); allowed.add(Math.abs(n)); }
    };
    const s = report.structural;
    add(s.changeCount);
    add(s.churn);
    add(s.netLoc);
    add(s.complexityDelta);
    for (const p of report.performance) {
        add(p.before);
        add(p.after);
        if (p.percentChange !== null) add(p.percentChange);
    }
    return allowed;
}

/** Standalone numeric tokens in `text` (ignores numbers glued to identifiers like p95). */
function extractNumbers(text: string): number[] {
    const normalized = text.replace(/−/g, '-'); // unicode minus → hyphen
    const matches = normalized.match(/(?<![A-Za-z0-9_])-?\d+(?:\.\d+)?/g) ?? [];
    return matches.map(Number).filter((n) => Number.isFinite(n));
}

/**
 * Numbers in `text` not grounded in `allowed` (beyond `tolerance`). The tolerance
 * absorbs display rounding of a measured percentage (e.g. -66.67 shown as 66.7 or
 * 67) without admitting a genuinely different figure. De-duplicated, in order.
 */
export function findUngroundedNumbers(
    text: string,
    allowed: ReadonlySet<number>,
    tolerance = 0.5,
): number[] {
    const out: number[] = [];
    const seen = new Set<number>();
    const allowedList = [...allowed];
    for (const n of extractNumbers(text)) {
        if (seen.has(n)) continue;
        seen.add(n);
        if (!allowedList.some((a) => Math.abs(n - a) <= tolerance)) out.push(n);
    }
    return out;
}

/** True when the narration cites no number absent from the report. */
export function isGrounded(text: string, report: ChangeImpactReport): boolean {
    return findUngroundedNumbers(text, allowedNumbersFor(report)).length === 0;
}
