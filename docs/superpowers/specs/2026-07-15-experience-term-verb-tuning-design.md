# Experience Lane: Term-Rule v2 + Verb-Alignment Guard -- Design

**Date:** 2026-07-15
**Status:** Approved design -- pending implementation plan
**Driver:** Live run 1eda06eb (MongoDB TSE JD) on the e2e-provenance build
(PR #491). Coverage read 2/6 with four zero-anchor misses where evidence
exists, and one bullet led "Owned end-to-end technical resolution" while its
primary cited line says "Assisted" (legitimised only by a secondary
citation's "own cases end-to-end").

**User decisions (locked):**
- Term rule: reuse `matchTier1` + an experience-lane emphasis-strip +
  light stemming. Retire the bespoke all-tokens rule.
- Verb guard: deterministic tiered check; violations route through ONE
  provenance-validated re-write (same lane as jd-echo); advisory on failure.
- Verb ceiling: the MAX tier across ALL of a bullet's cited career lines
  (any cited line legitimises the verb -- the live "Owned" case is
  compliant).
- Deterministic throughout; no LLM in scorer or guard; fail-closed spirit
  stays (a target with genuinely no evidence remains missing); summary lane
  and `matchTier1` itself untouched.

## Component 1 -- Term-rule v2 (files: ats/gate/experience-coverage.ts,
ats/gate/experience-ats-targets.ts)

One shared predicate replaces the bespoke `requiredTerms`/`tokenize`/
`matchesAllTerms` machinery (whose duplication of `normalizeTerm` the T3
review flagged):

```
experienceTermMatch(targetSkill: string, text: string): boolean
  1. emphasis-strip: drop EXPERIENCE_EMPHASIS_TOKENS from the target's
     tokens: [mission, critical, rapid, rapidly, complex, deep, extensive]
     (experience-lane-only list; QUALIFIERS stays untouched because it
     feeds the whole body gate).
  2. stem BOTH the remaining target tokens and the candidate text with
     lightStem: strip trailing "ly"; strip trailing "ing"; only when the
     remaining stem is >= 4 chars (rapidly->rapid, learning->learn,
     scripting->script; "ring" never becomes "r").
  3. call matchTier1(strippedTarget, stemmedText) -- inheriting QUALIFIERS
     stripping, in-sentence proximity (PROXIMITY_WINDOW), exact-token
     semantics, and the language-category credit (LANG_CATEGORY_CUE +
     LANGUAGE_EXEMPLARS), all unchanged in keyword-match.ts.
```

- `scoreExperienceCoverage`'s term path: a target is term-covered when
  `experienceTermMatch(target.skill, bullet.text)` for some ONE bullet.
  The anchor path (sources intersect target.anchors) is unchanged.
- `anchorsFor` in selectExperienceAtsTargets uses the SAME predicate
  against career-line text (single source of matching truth).
- `GENERIC_TARGET_TOKENS`, `requiredTerms`, `matchesAllTerms`, and the
  local `tokenize` are deleted; their tests migrate to the new predicate.
- An all-emphasis target (every token stripped) falls back to the
  UNSTRIPPED token set before step 2 -- never an empty term (mirrors the
  old all-generic fallback).

Verified expectations against run 1eda06eb (become eval fixtures):
- "mission-critical production database systems" -> "production database"
  -> COVERED by the RDS/Aurora bullet (was missing).
- "code reading and scripting" -> language-cue + "JavaScript" in the
  tooling bullet -> COVERED (was missing).
- "rapid technical learning" -> "technical learn(ing)" vs "self-training"
  -> STILL MISSING (synonym gap; honest fail-closed -- documented, not a
  defect).
- Previously covered targets (Linux via terms, customer communication via
  anchor) stay covered -- regression cases.

## Component 2 -- Verb-alignment guard (new file:
agents/writer/verb-alignment.ts; run-pipeline routing generalised)

- `VERB_TIERS: ReadonlyMap<string, 1|2|3|4>` -- lead-verb lexicon:
  tier 1 assist, support, help, contribute, participate;
  tier 2 troubleshoot, diagnose, resolve, investigate, debug, triage,
  guide, analyse, analyze, audit, monitor;
  tier 3 own, lead, manage, drive, deliver, coordinate, run;
  tier 4 architect, design, establish, found, invent.
  Verbs are matched by lightStem'd first word of the bullet (leading
  adverbs like "rapidly" are skipped before taking the lead verb).
  Unknown verbs are NEUTRAL: no tier, never a violation (fail-open --
  build, create, prototype, write etc. stay unclassified until data says
  otherwise).
- `checkVerbAlignment(kept: ExperienceAgentOutput, lines: IndexedCareerLine[])`
  -> `Array<{ role: number; bullet: number; verb: string; tier: number;
  ceiling: number }>`. For each bullet with a classified lead verb: the
  ceiling is the MAX tier of any classified verb appearing ANYWHERE in ANY
  of the bullet's cited lines (not only lead position -- "to own cases
  end-to-end" mid-line counts). tier > ceiling -> violation. Bullets with
  no classified lead verb, or citing no resolvable line, are skipped.
- Wiring: `routeExperienceJdEcho` generalises to `routeExperienceRepairs`:
  it now collects BOTH `experience_bullet_jd_echo` guard flags AND
  `checkVerbAlignment` findings; when either set is non-empty it makes the
  SAME single provenance-validated re-write call, with the message gaining
  a `verbAlignment` block beside the existing `echoCleanup` block (list of
  flagged bullets + the instruction: align each lead verb to what the
  cited lines support; never weaken a verb the evidence does support).
  Still at most ONE routed call per run; invalid/thrown output -> original
  stands; violations recorded as advisory either way.
- Observability: violation code `experience_verb_upgrade` (stage
  `resume_guard`, one per finding) + Loki event
  `experience_verb_alignment` `{violations: [{role, bullet, verb, tier,
  ceiling}]}` emitted when non-empty. Bounded (verbs come from the
  lexicon; indices are small ints). No new Prometheus labels.
- After a successful routed re-write, `checkVerbAlignment` re-runs on the
  new output for the diagnostics only (no second re-write) so the recorded
  state describes the shipped text.

## Error handling

Everything degrades to current behaviour: predicate and guard are pure;
routing keeps the existing catch/advisory semantics; a lexicon miss means
no violation, never a crash.

## Testing

- Unit: lightStem edge cases (min-length guard, ly+ing, idempotence);
  experienceTermMatch (all four live cases + all-emphasis fallback +
  language-cue + proximity respected via matchTier1); checkVerbAlignment
  (upgrade flagged; secondary-citation legitimised = the live "Owned"
  case compliant; unknown lead verb neutral; mid-line ceiling verbs
  counted; skip on unresolvable sources); routeExperienceRepairs (echo
  only, verb only, both -> one call; invalid output discarded; re-check
  after splice).
- Evals (house rule -- scorer change ships with its eval): the three live
  term fixtures with honest expectations (two flip to covered,
  rapid-learning stays missing), regression fixtures for
  previously-covered targets, verb fixtures (upgrade + legitimised).
- Gates: full suite green (growth only from 151/1271), tsc, ROOT eslint,
  ASCII-only, UK English; prompt-manifest untouched unless the persona
  needs a verb rule line (if touched: version bump + sha regeneration).

## Consequences

- Coverage numbers become honest about the evidence rather than about
  token spelling; the remaining "missing" verdicts are true synonym gaps.
- The matching subsystem is the single source of term-matching truth for
  the experience lane; the duplicated tokenizer is gone.
- Verb honesty is enforced by the same bounded, provenance-validated
  machinery as jd-echo -- one lexicon, one routed call, no new failure
  modes.
