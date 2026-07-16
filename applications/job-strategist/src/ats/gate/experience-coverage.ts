/** @format */
import { matchTier1, normalizeTerm, padded } from '../matching/keyword-match.js';
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

/** Drop `EXPERIENCE_EMPHASIS_TOKENS` from `targetSkill`'s tokens -- if that
 *  strips every token (an all-emphasis target like "mission critical"), fall
 *  back to the unstripped set so the requirement is never empty. Shared by
 *  both the unstemmed and stemmed passes below so they strip identically. */
function emphasisStrippedTokens(targetSkill: string): string[] {
  const tokens = tokenize(targetSkill);
  const significant = tokens.filter((t) => !EXPERIENCE_EMPHASIS_TOKENS.has(t));
  return significant.length > 0 ? significant : tokens;
}

/**
 * Pass 1 (G2, run 976403b3): `matchTier1` on the emphasis-stripped target
 * WITHOUT lightStem, against the RAW (unstemmed) text. Restores two things
 * the stemmed pass below defeats: exact-phrase substring matching (a stemmed
 * word is rarely a real word any more), and matchTier1's own built-in
 * language-category cue -- which tests the RAW target string for a literal
 * "languages"/"scripting"/"programming"/"coding" word and credits it when the
 * RAW text names a real language exemplar. Stemming "scripting" -> "script"
 * silently broke that cue's `\bscripting\b` match before this pass existed.
 */
function unstemmedMatch(targetSkill: string, text: string): boolean {
  const joined = emphasisStrippedTokens(targetSkill).join(' ');
  return matchTier1(joined, text);
}

/** Pass 2: the pre-existing behaviour -- `lightStem` the remaining target
 *  tokens AND every token of `text`, so "rapid technical learning" bridges a
 *  bullet mentioning "learn" and "scripting" bridges one mentioning "script". */
function stemmedMatch(targetSkill: string, text: string): boolean {
  const joined = emphasisStrippedTokens(targetSkill).map(lightStem).join(' ');
  return matchTier1(joined, stemText(text));
}

/** Passes 1-2 combined -- the "does the core (non-enumeration) phrase match"
 *  check, reused both for the full target and for an enumeration's base
 *  phrase (pass 3 below). */
function matchesCoreTerm(targetSkill: string, text: string): boolean {
  return unstemmedMatch(targetSkill, text) || stemmedMatch(targetSkill, text);
}

// Pass 3: a target shaped `base (m1, m2, ... [, etc.])` -- e.g. "scripting
// (Python, Java, JavaScript, Go, etc.)". Flattening every member into one
// co-occurrence check (the pre-G2 behaviour) demanded ALL of them appear in
// ONE bullet, which is not what an enumeration means: the JD is naming
// examples of the base requirement, not asking for every example at once.
//
// Plain string ops rather than a single `base (...)` regex -- a `.*?` before
// a `(...)` group is backtracking-prone on adversarial input; indexOf/slice
// is both linear and clearer for this exact shape.
function splitEnumeration(targetSkill: string): { base: string; membersRaw: string } | null {
  const trimmed = targetSkill.trim();
  if (!trimmed.endsWith(')')) return null;
  const openIdx = trimmed.indexOf('(');
  if (openIdx === -1) return null;
  return { base: trimmed.slice(0, openIdx).trim(), membersRaw: trimmed.slice(openIdx + 1, -1) };
}

/**
 * Split an enumeration-shaped target into its base phrase and member tokens;
 * covered when the BASE matches via passes 1-2 above, OR any ONE member
 * token appears whole-word (normalized) in `text`. `normalizeTerm` already
 * drops "etc"/"etc." (a QUALIFIERS entry), so the trailing "etc." in the
 * source pattern needs no special-casing here. Returns `false` for a
 * non-enumeration target (no parenthetical suffix).
 *
 * Short-token guard: a member must be >= 3 characters (normalized) to
 * participate -- "tools (Git, Go, C, R)" must never be credited by prose
 * "go" ("led the go-live"), "c" or "r" tokens, and a false credit here
 * cascades (a falsely-anchored career line is quoted as grounding in the
 * prompt, and any bullet citing it then passes anchor-credit coverage).
 * Dropped members rely on the base/cue passes instead. Same >= 3 precedent
 * as matchTier1's own significant-token fallback, and the language exemplar
 * lists deliberately spell ' golang ', never ' go '.
 */
function enumerationMatch(targetSkill: string, text: string): boolean {
  const split = splitEnumeration(targetSkill);
  if (!split) return false;

  if (split.base.length > 0 && matchesCoreTerm(split.base, text)) return true;

  const paddedText = padded(text);
  const members = split.membersRaw.split(',').map((member) => normalizeTerm(member)).filter((m) => m.length >= 3);
  return members.some((member) => paddedText.includes(` ${member} `));
}

// Pass 4 (lane-local cue extension): a raw target in the code
// reading/comprehension class ("code reading", "code review(s)", "code
// comprehension", "reading code") is treated as language-cue class --
// covered when the text names a real language exemplar. Deliberately
// NARROW: a bare `\bcode\b` over-credits ("code of conduct" plus any
// Python mention anywhere would score as covered), so the cue only fires
// on the reading/comprehension phrases above. `keyword-match.ts`'s own
// LANG_CATEGORY_CUE/LANGUAGE_EXEMPLARS (source of this list) only test for
// "languages?/scripting/programming/coding", never "code", and are not
// exported, so the exemplar list is re-declared here, lane-local, kept
// identical to keyword-match.ts's own copy.
const LANE_CODE_CUE = /\bcode (reading|review(s)?|comprehension)\b|\breading code\b/i;
const LANE_LANGUAGE_EXEMPLARS = [
  ' python ', ' bash ', ' shell ', ' powershell ', ' sql ', ' javascript ', ' typescript ',
  ' golang ', ' java ', ' ruby ', ' rust ', ' kotlin ', ' scala ', ' perl ',
];

function laneLanguageCueMatch(targetSkill: string, text: string): boolean {
  if (!LANE_CODE_CUE.test(targetSkill)) return false;
  const paddedText = padded(text);
  return LANE_LANGUAGE_EXEMPLARS.some((exemplar) => paddedText.includes(exemplar));
}

// Pass 5 (G3, run d3d9ab76): soft-skill synonym groups. JD soft-skill targets
// ("collaboration", "full-stack troubleshooting") legitimately miss career
// lines that demonstrate the skill in synonym vocabulary (partnered,
// coordinated, end-to-end resolution) without ever using the JD's token.
//
// Fail-closed by construction, two conditions both required:
//  - EVERY emphasis-stripped, stemmed target token must sit inside the
//    group's `vocab` -- the target has to BE the soft skill, so a tech
//    phrase that merely contains a soft-skill token ("collaboration tools
//    (Jira, Confluence)") never rides the group;
//  - EVERY regex in `evidence` must match `text` -- "full-stack
//    troubleshooting" needs BOTH a span signal (end-to-end / full-stack /
//    across the stack) AND a troubleshooting/resolution signal, so a line
//    about shipping a feature end-to-end does not credit it.
interface SoftSkillSynonymGroup {
  readonly vocab: ReadonlySet<string>;
  readonly evidence: readonly RegExp[];
}

const SOFT_SKILL_SYNONYM_GROUPS: readonly SoftSkillSynonymGroup[] = [
  {
    // Stemmed forms (lightStem strips -ing: collaborating -> collaborat).
    vocab: new Set([
      'collaboration', 'collaborate', 'collaborated', 'collaborat', 'collaborative',
      'teamwork', 'team', 'teams', 'cross', 'functional', 'stakeholder', 'stakeholders',
    ]),
    // Prefix-stem alternation (partner -> partnered/partnering/partnership)
    // keeps the pattern simple; the \b prefix anchor is the guard that matters.
    evidence: [
      /\b(partner|coordinat|collaborat|liais|engag)\w*|\bcross[- ](functional|team)\b/i,
    ],
  },
  {
    vocab: new Set([
      'full', 'stack', 'fullstack', 'end', 'troubleshoot', 'troubleshooting', 'troubleshot',
      'debugging', 'debug', 'diagnosis', 'diagnostics',
    ]),
    evidence: [
      /\b(end[- ]to[- ]end|full[- ]stack|across the stack)\b/i,
      /\b(troubleshoot|troubleshot|resolut|resolv|diagnos|debug)\w*/i,
    ],
  },
];

function softSkillSynonymMatch(targetSkill: string, text: string): boolean {
  const stemmedTokens = emphasisStrippedTokens(targetSkill).map(lightStem);
  return SOFT_SKILL_SYNONYM_GROUPS.some((group) =>
    stemmedTokens.every((token) => group.vocab.has(token))
    && group.evidence.every((re) => re.test(text)));
}

/**
 * Experience-lane term match: does `text` demonstrate `targetSkill` in the
 * JD's vocabulary, without demanding its exact wording? A five-way OR, still
 * pure and deterministic:
 *
 *  1. `unstemmedMatch` -- exact-phrase + matchTier1's own raw language cue.
 *  2. `stemmedMatch` -- the original morphology-bridging pass (rapidly->rapid).
 *  3. `enumerationMatch` -- a `base (m1, m2, ...)` target covered by its base
 *     OR any one member token named in `text`.
 *  4. `laneLanguageCueMatch` -- a target in the code reading/comprehension
 *     class ("code reading"/"code review(s)"/"code comprehension"/"reading
 *     code" -- NOT a bare "code" token) covered when `text` names a real
 *     language.
 *  5. `softSkillSynonymMatch` -- a target that IS a soft-skill concept
 *     (every significant token inside one group's vocabulary) covered when
 *     `text` demonstrates it in synonym vocabulary (partnered/coordinated
 *     for collaboration; end-to-end + a troubleshooting signal for
 *     full-stack troubleshooting).
 *
 * Single source of matching truth for the experience lane -- also used by
 * `anchorsFor` in experience-ats-targets.ts and the projects lane (via
 * `scoreProjectsCoverage`/deterministic fallback ranking), so "a bullet
 * term-matches a target" means exactly one thing everywhere it is asked.
 * Fail-closed intent preserved: a target outside the narrowed cue class,
 * with no enumeration members and no term match across every check, stays
 * missing -- "code of conduct" never rides the language cue.
 */
export function experienceTermMatch(targetSkill: string, text: string): boolean {
  return matchesCoreTerm(targetSkill, text)
    || enumerationMatch(targetSkill, text)
    || laneLanguageCueMatch(targetSkill, text)
    || softSkillSynonymMatch(targetSkill, text);
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
