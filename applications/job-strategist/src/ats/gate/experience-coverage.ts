/** @format */
import { padded } from '../matching/keyword-match.js';
import type { ExperienceAtsTarget } from './experience-ats-targets.js';
import type { SummaryCoverage } from './summary-coverage.js';

/**
 * Generic tokens that carry no discriminating signal for a target's own
 * coverage rule -- stripped from `requiredTerms(skill)` so a target like
 * "Linux systems engineering" reduces to its distinctive core {linux}
 * instead of demanding an exact "systems engineering" phrase a legitimately
 * rewritten bullet is unlikely to reproduce verbatim. Deliberately narrower
 * than keyword-match.ts's QUALIFIERS list -- this only strips the generic
 * nouns that pad a JD skill phrase, not every stopword `matchTier1` strips
 * (this scorer judges coverage of ONE target, not a cross-corpus match).
 */
export const GENERIC_TARGET_TOKENS: ReadonlySet<string> = new Set([
  'systems', 'system', 'engineering', 'experience', 'analysis', 'skills',
  'skill', 'knowledge', 'management', 'ability', 'and', 'of', 'the',
]);

function tokenize(skill: string): string[] {
  return skill
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

/**
 * The discriminating tokens a bullet (or career line) must whole-word
 * contain to earn term-tolerant credit for `skill` -- every token minus
 * GENERIC_TARGET_TOKENS noise. Falls back to the FULL token set when every
 * token is generic (e.g. "systems engineering" -- nothing left to
 * discriminate on, so the whole phrase is required rather than an empty,
 * vacuously-true requirement).
 */
export function requiredTerms(skill: string): string[] {
  const tokens = tokenize(skill);
  const significant = tokens.filter((t) => !GENERIC_TARGET_TOKENS.has(t));
  return significant.length > 0 ? significant : tokens;
}

/**
 * Whole-word, order-free containment: every term in `terms` is a padded
 * substring of `paddedHaystack`. Empty `terms` never matches -- a target
 * that reduces to zero required terms must never be vacuously covered.
 * Shared by `scoreExperienceCoverage` below and the anchor computation in
 * `experience-ats-targets.ts` so "a career line term-matches a target" means
 * exactly one thing in both places.
 */
export function matchesAllTerms(paddedHaystack: string, terms: readonly string[]): boolean {
  return terms.length > 0 && terms.every((t) => paddedHaystack.includes(` ${t} `));
}

export interface ScorableBullet {
  readonly text: string;
  readonly sources: readonly string[];
}

/**
 * Evidence-anchored, term-tolerant coverage of the experience section
 * against its ATS targets (Task 3 redesign -- see `experience-ats-targets.ts`
 * for the shared `requiredTerms`/`matchesAllTerms` anchor computation).
 *
 * A target is covered when ONE bullet either:
 *  (a) cites one of the target's anchor career-line ids in its `sources`, or
 *  (b) whole-word, order-free contains every one of `requiredTerms(target.skill)`.
 *
 * Deliberately more tolerant than the summary lane's `scoreSummaryCoverage`
 * (exact adjacent phrase -- see its own do-not-relax comment): the experience
 * section legitimately REWRITES career-history prose into the JD's
 * vocabulary, so "Linux systems engineering" should credit a bullet that
 * demonstrates Linux system administration without the literal phrase,
 * PROVIDED it is anchored to real career evidence or genuinely names the
 * discriminating terms. Fail-closed: a target with zero anchors and zero
 * matching terms across every bullet stays missing, exactly like today.
 */
export function scoreExperienceCoverage(
  bullets: readonly ScorableBullet[],
  targets: readonly ExperienceAtsTarget[],
): SummaryCoverage {
  const missing: string[] = [];
  let covered = 0;
  for (const target of targets) {
    const terms = requiredTerms(target.skill);
    const anchors = new Set(target.anchors);
    const isCovered = bullets.some((b) => {
      if (anchors.size > 0 && b.sources.some((s) => anchors.has(s))) return true;
      return matchesAllTerms(padded(b.text), terms);
    });
    if (isCovered) covered += 1;
    else missing.push(target.skill);
  }
  return { targets: targets.length, covered, missing };
}
