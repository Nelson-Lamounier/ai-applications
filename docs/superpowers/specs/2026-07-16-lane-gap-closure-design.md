# Lane Gap Closure -- Design

**Date:** 2026-07-16
**Status:** Approved (user: "fix it and close all the gaps"; design approved in-session)
**Driver:** Live run 976403b3 (MongoDB TSE JD, image 1179f80a): projects agent
fell back a FOURTH time with a NEW mode (`entries` emitted as a stringified
JSON array -> zod `invalid_type`), and experience coverage stuck at 2/6 on
structural misses (enumeration targets like "scripting (Python, Java,
JavaScript, Go, etc.)" demand every language token in one bullet; the
matcher's language-category cue is disabled because the target is stemmed
before matchTier1 sees it -- the tracked #492 Low, now biting live). Plus the
tracked-Low cluster from the #493 reviews.

## G1 -- Stringified-entries tolerance (projects-schema.ts)

In `normaliseProjectsAgentOutput`: when `raw.entries` is a string, attempt
`JSON.parse`; if the result is an array, substitute it (count +1 in
`normalisedExtras`) and continue the normal per-item normalisation; on parse
failure or non-array result, passthrough unchanged (zod still hard-rejects).
No other shape handling changes; the fail-closed provenance boundary is
untouched.

## G2 -- Enumeration + language-cue coverage (ats/gate/experience-coverage.ts
ONLY; ats/matching/keyword-match.ts untouched)

`experienceTermMatch(targetSkill, text)` becomes a three-shot OR, still pure
and deterministic:

1. UNSTEMMED pass: `matchTier1(emphasisStripped(target), text)` -- restores
   the built-in language-category cue (raw "scripting"/"coding"/"languages"
   + any LANGUAGE_EXEMPLAR in the text) and exact-phrase matching that
   stemming was defeating.
2. STEMMED pass: the existing behaviour (morphology: rapidly->rapid etc.).
3. ENUMERATION rule: a target containing a parenthetical list -- pattern
   `base (m1, m2, ... [, etc.])` -- splits into the base phrase and member
   tokens; covered when the BASE matches via passes 1-2 OR ANY ONE member
   token appears whole-word (normalised) in the text. "scripting (Python,
   Java, JavaScript, Go, etc.)" is covered by a bullet naming JavaScript.
4. Lane-local cue extension: a raw target containing the token `code`
   (e.g. "code reading") is treated as language-cue class -- covered when
   the text names a LANGUAGE_EXEMPLAR. Implemented in experience-coverage.ts
   (a lane-local regex + the exemplar list re-declared or imported if
   exported); keyword-match.ts's own LANG_CATEGORY_CUE stays untouched.

Fail-closed intent preserved: a target with no cue, no enumeration members,
and no term match stays missing. Anchor path unchanged.

## G3 -- Tracked-Lows cluster

- `withProjectsDescriptionLock` (agents/writer/experience-lock.ts): DROP the
  index fallback -- name is identity. A renamed/inserted entry keeps the
  pass's description (documented); this kills both cross-assign cases
  (rename+reorder, insertion) flagged in the #493 reviews.
- Empty-pitch edge: description stamp falls back pitch -> TAGLINE -> ''.
  `loadProjectAgentInputs` SELECT gains `COALESCE(p.tagline,'')`; the
  stamp-callers pass it through (rankProjectEntry + the agent-path stamp).
- Owed micro-tests: (a) fillResumeProjects extras-summation glue
  (first + rewrite normalisedExtras persisted); (b) experience lane's
  rewrite-threw branch asserts the dropped[] array propagates.

## Testing

Evals gain the two live cases verbatim: the stringified-entries payload
shape from run 976403b3 (accepted, parsed, then normally normalised), and
"scripting (Python, Java, JavaScript, Go, etc.)" covered by the JavaScript
tooling bullet while a memberless/cueless target stays missing. Unit tests
per change; suite growth only from 154 suites / 1360 tests; tsc; ROOT
eslint; ASCII; UK English. Live validation: next JD run.

## Consequences

- The projects agent's two observed failure modes (echoed keys, stringified
  entries) are both normalised away; remaining rejections are genuine
  violations.
- Enumeration and cue-class JD targets score honestly; remaining "missing"
  verdicts are true evidence gaps.
- The description lock is identity-safe; blank descriptions only occur when
  a project has neither pitch nor tagline.
