/** @format */
import { matchTier1 } from '../matching/keyword-match.js';
import type { ExperienceAtsTarget } from './experience-ats-targets.js';
import type { SummaryCoverage } from './summary-coverage.js';

/**
 * Emphasis and discipline-suffix tokens that carry no discriminating signal
 * on their own -- a JD phrase like "mission-critical production database
 * systems" is asking for the database work, not for a bullet that literally
 * parrots "mission" and "critical", and "Linux systems engineering" is asking
 * for the Linux work, not the literal word "engineering". Stripped from the
 * target's tokens before matching so the requirement reduces to its
 * distinctive core. The discipline suffixes (engineering, analysis,
 * management) restore the retired experience-lane generic semantics of the
 * old GENERIC_TARGET_TOKENS list; QUALIFIERS itself stays untouched because
 * the body gate must not over-credit terms like "project management". This
 * list is the experience-lane-only vocabulary.
 */
export const EXPERIENCE_EMPHASIS_TOKENS: ReadonlySet<string> = new Set([
  'mission', 'critical', 'rapid', 'rapidly', 'complex', 'deep', 'extensive',
  'engineering', 'analysis', 'management',
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
 * Strip a trailing "ly" or trailing "ing" -- ONLY when the remaining stem is
 * >= 4 chars, so a short root is never mangled ("ring" stays "ring", "fly"
 * stays "fly", "coding" stays "coding" since its remainder "cod" is 3 chars).
 * Idempotent: a word with no further strippable suffix is returned unchanged
 * on a second pass. Deliberately light -- this is not a real stemmer, just
 * enough to bridge "rapidly"/"rapid", "learning"/"learn",
 * "scripting"/"script" for the experience lane.
 */
export function lightStem(token: string): string {
  const lower = token.toLowerCase();
  if (lower.endsWith('ly') && lower.length - 2 >= 4) return lower.slice(0, -2);
  if (lower.endsWith('ing') && lower.length - 3 >= 4) return lower.slice(0, -3);
  return lower;
}

/** lightStem every alphabetic run in free text, preserving punctuation,
 *  spacing and sentence boundaries so `matchTier1`'s proximity/sentence
 *  logic keeps working unchanged on the stemmed stream. */
function stemText(text: string): string {
  return text.replace(/[A-Za-z]+/g, (word) => lightStem(word));
}

/**
 * Experience-lane term match: does `text` demonstrate `targetSkill` in the
 * JD's vocabulary, without demanding its exact wording? Delegates entirely
 * to `matchTier1` (literal/normalized substring, in-sentence proximity,
 * language-category credit) after two experience-lane-only transforms:
 *
 *  1. Drop `EXPERIENCE_EMPHASIS_TOKENS` from the target's tokens -- if that
 *     strips every token (an all-emphasis target like "mission critical"),
 *     fall back to the unstripped set so the requirement is never empty.
 *  2. `lightStem` the remaining target tokens AND every token of `text`, so
 *     "rapid technical learning" bridges a bullet mentioning "learn" and
 *     "scripting" bridges one mentioning "script".
 *
 * Single source of matching truth for the experience lane -- also used by
 * `anchorsFor` in experience-ats-targets.ts, so "a career line term-matches
 * a target" means exactly one thing in both places.
 */
export function experienceTermMatch(targetSkill: string, text: string): boolean {
  const tokens = tokenize(targetSkill);
  const significant = tokens.filter((t) => !EXPERIENCE_EMPHASIS_TOKENS.has(t));
  const kept = significant.length > 0 ? significant : tokens;
  const strippedTargetJoined = kept.map(lightStem).join(' ');
  return matchTier1(strippedTargetJoined, stemText(text));
}

export interface ScorableBullet {
  readonly text: string;
  readonly sources: readonly string[];
}

/**
 * Evidence-anchored, term-tolerant coverage of the experience section
 * against its ATS targets (Task 3 redesign -- see `experience-ats-targets.ts`
 * for the shared `experienceTermMatch` anchor computation).
 *
 * A target is covered when ONE bullet either:
 *  (a) cites one of the target's anchor career-line ids in its `sources`, or
 *  (b) `experienceTermMatch(target.skill, bullet.text)` is true.
 *
 * Deliberately more tolerant than the summary lane's `scoreSummaryCoverage`
 * (exact adjacent phrase -- see its own do-not-relax comment): the experience
 * section legitimately REWRITES career-history prose into the JD's
 * vocabulary, so "Linux systems engineering" should credit a bullet that
 * demonstrates Linux system administration without the literal phrase,
 * PROVIDED it is anchored to real career evidence or genuinely names the
 * discriminating terms. Fail-closed: a target with zero anchors and zero
 * matching terms across every bullet stays missing, exactly like today (an
 * empty `target.skill` normalizes to an empty `matchTier1` term, which never
 * matches).
 */
export function scoreExperienceCoverage(
  bullets: readonly ScorableBullet[],
  targets: readonly ExperienceAtsTarget[],
): SummaryCoverage {
  const missing: string[] = [];
  let covered = 0;
  for (const target of targets) {
    const anchors = new Set(target.anchors);
    const isCovered = bullets.some((b) => {
      if (anchors.size > 0 && b.sources.some((s) => anchors.has(s))) return true;
      return experienceTermMatch(target.skill, b.text);
    });
    if (isCovered) covered += 1;
    else missing.push(target.skill);
  }
  return { targets: targets.length, covered, missing };
}
