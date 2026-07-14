/** @format */
import type { SummaryAtsTarget } from './summary-ats-targets.js';
import { normalizeTerm, padded } from '../matching/keyword-match.js';

export interface SummaryCoverage {
  readonly targets: number;
  readonly covered: number;
  readonly missing: string[];
}

/**
 * Deterministic coverage of the summary against its ATS targets.
 *
 * A target is covered when its normalised skill appears as a space-padded
 * substring of the normalised summary -- i.e. a whole-word match for single
 * tokens ("Go" does not match "ongoing") and the exact ADJACENT phrase for
 * multi-word skills ("project management" as consecutive words).
 *
 * This is deliberately STRICTER than the body ATS gate's `matchTier1`, whose F4
 * branch credits multi-word tokens that merely co-occur within 12 words of one
 * sentence. The summary is the highest-value ATS real estate; we want it to carry
 * the literal keyword, so proximity co-occurrence is NOT enough here. Do not
 * relax this to `matchTier1` for "gate consistency" -- the divergence is intended.
 */
export function scoreSummaryCoverage(
  summary: string,
  targets: readonly SummaryAtsTarget[],
): SummaryCoverage {
  const haystack = padded(summary);
  const missing: string[] = [];
  let covered = 0;
  for (const t of targets) {
    const norm = normalizeTerm(t.skill);
    if (norm.length > 0 && haystack.includes(` ${norm} `)) covered += 1;
    else missing.push(t.skill);
  }
  return { targets: targets.length, covered, missing };
}
