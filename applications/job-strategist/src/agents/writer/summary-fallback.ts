/** @format */
import { namesGap } from '../quality/guards/summary-rules.js';
import { SENTENCE_SPLIT } from '../quality/guards/text.js';

/** Guard-safe minimal summary from the Fit Summary, used when the summary agent fails.
 *  Reuses the real `namesGap` guard predicate (instead of a parallel regex) so the
 *  result is guaranteed to satisfy `namesGap(result) === false` — this fallback exists
 *  to survive a Bedrock outage without needing the Haiku rewrite pass, so it must never
 *  itself trip the guard it is standing in for. */
export function deterministicSummary(fitSummary: string, targetRole: string): string {
    const fallback = `${targetRole} with proven, evidence-backed delivery across the role's core responsibilities.`;

    // Drop any sentence that names a gap/shortfall; keep the positive positioning.
    const kept = fitSummary.split(SENTENCE_SPLIT).filter((s) => !namesGap(s));
    const joined = kept.join(' ').trim();

    if (joined.length === 0) return fallback;
    // Defensive: a gap pattern could span a sentence boundary and only surface once rejoined.
    if (namesGap(joined)) return fallback;
    return joined;
}
