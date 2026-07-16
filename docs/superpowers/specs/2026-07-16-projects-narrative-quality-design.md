# Projects Narrative Quality + Tier-Weighted Themes -- Design

**Date:** 2026-07-16
**Status:** Approved design -- pending implementation plan
**Driver:** Breakthrough run fe421faf shipped the first agent-authored
Projects section, exposing two quality gaps: (1) theme activation ranked by
raw hit count let concept-accumulated themes outrank REQUIRED JD boxes
(networking-protocols, a required box, lost the top-3 cut); (2) composed
bullets leaked internal vocabulary -- an environment-variable name
"(RETRIEVAL_PREFILTER)" and a bare acronym "HNSW" reached the resume -- and
read as skill dumps rather than the user's required narrative profile:
WHAT I did, WHAT concept, WHY it was used, WHAT result/value.

**User decisions (locked):**
- Tier-weighted activation + cap 4 (approved verbally before this spec).
- Composed-bullet four-beat narrative contract with hard style rules.
- **GENERALITY IS A REQUIREMENT: production-ready for ANY JD and ANY
  user.** Nothing in the implementation may hardcode this user's skills,
  repos, identifiers, or the MongoDB JD: tier weights read the JD
  extraction's generic structure; the style lint is generic pattern-based
  (never a blocklist of known identifiers); evals must include at least
  one non-MongoDB, non-infrastructure JD proving the machinery generalises
  (and a no-activation JD proving the no-op path).

## Component 1 -- Tier-weighted theme activation (operations-themes.ts)

- `activateThemes` signature becomes tier-aware:
  `activateThemes(jdStrings: readonly TieredJdString[])` where
  `TieredJdString = { text: string; tier: 'disqualifying' | 'required' |
  'preferred' }` (caller maps: hardRequirements[].skill with
  disqualifying=true -> 'disqualifying', other hardRequirements ->
  'required', preferredSkills + concepts -> 'preferred'). Keep a
  backwards-compatible overload or migrate the single caller -- one
  source of flattening (run-pipeline's jdStringsForThemes).
- Scoring: per theme, sum over DISTINCT matched jd strings of
  weight(tier): disqualifying=3, required=2, preferred=1. Sort DESC, ties
  by ontology order. Cap raised MAX_ACTIVATED_THEMES 3 -> 4.
- Generic by construction: tiers come from JdSignal fields every JD
  extraction produces; no per-user or per-JD data.

## Component 2 -- Composed-bullet narrative contract (persona v4 +
projects-message.ts)

Persona + message gain the four-beat COMPOSED-bullet profile (curated
bullets untouched -- byte-fidelity):
1. WHAT I did -- open with a specific action verb;
2. the CONCEPT in public, JD-recognisable vocabulary (the concept a
   hiring engineer or ATS knows, never project-internal naming);
3. WHY -- the problem or constraint it addressed;
4. RESULT/VALUE -- the outcome, qualitative or measured.

Hard style rules (stated in the persona, enforced by Component 3):
- INTERNAL IDENTIFIERS BANNED in resume text: environment-variable names,
  code constants, repo-internal feature names (write the public concept
  instead).
- Acronyms are introduced WITH their concept on first use in a bullet
  ("HNSW approximate-nearest-neighbour indexing").
- Number style: exact figures or "more than N" -- never bare "N+".
- Preference rule: when a curated bullet carries internal jargon and the
  entry's own pool evidence supports the same fact, COMPOSE the clean
  version instead of selecting the jargony quote (ids still authoritative;
  provenance rules unchanged).
Persona front-matter version bump + manifest regeneration.

## Component 3 -- Deterministic composed-bullet style guard (new
`agents/writer/projects-style.ts`)

- `checkComposedBulletStyle(text): StyleFinding[]` -- GENERIC patterns
  only:
  - internal-identifier: tokens matching `/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/`
    (SNAKE_CASE constants) and parenthesised ALL-CAPS singletons of
    length >= 8 with no vowels-space heuristic is NOT required -- keep to
    the SNAKE_CASE rule plus `\b[a-z]+[A-Z]\w*\(\)` (code call syntax) --
    deterministic, no allowlist/blocklist of specific names;
  - bare plus-numeric: `/\b\d+\+/` (e.g. "100+", "12k+" -- flag both;
    the persona's replacement is "more than N");
  - unintroduced acronym heuristic: an ALL-CAPS token of length 3-6 that
    appears WITHOUT any lowercase word adjacent in the same clause is NOT
    reliably detectable -- OUT OF SCOPE for the lint (persona-only rule);
    document the decision.
- Wiring: style findings on COMPOSED bullets are computed at validation
  time (beside validateProjectsProvenance, never inside it), fed into the
  projects agent's existing single ATS rewrite call as additional repair
  context (same bounded pattern as the experience lane's jd-echo routing:
  at most the one existing rewrite, provenance-validated); still-dirty
  output SHIPS with advisory violations (`projects_style` stage, code
  `composed_style_violation`) -- never a new fallback path.
- Curated bullets: exempt (byte-fidelity); findings on curated text are
  recorded as advisory ONLY (visibility for the future multi-angle
  case-study loop), never repaired at resume time.

## Component 4 -- Observability + evals (generality-proving)

- Diag: `projectsAgent.style = { composedFindings: number,
  curatedAdvisories: number }` (bounded ints); Loki event
  `projects_style_findings` when non-zero.
- Evals (each with adversarial/positive controls, reusing runtime
  primitives):
  (a) tier activation: the MongoDB TSE JD (networking-protocols is a
      required box) now activates networking-protocols within the cap;
  (b) GENERALITY: a non-infrastructure JD (e.g. a data-engineering JD
      with disqualifying "ETL pipelines" and preferred storage concepts)
      activates the right themes by tier, proving no MongoDB coupling;
      and a frontend-only JD still activates ZERO (no-op path intact);
  (c) style guard: "(RETRIEVAL_PREFILTER)" flagged; "100+"/"12k+"
      flagged; a clean four-beat bullet passes; a curated bullet with the
      same patterns yields advisory-only;
  (d) repair loop: style findings routed into the rewrite produce a
      clean composed bullet that passes provenance; a rewrite that fails
      provenance ships the original with advisories.

## Error handling

All fail-open: style guard is pure; findings never reject an output;
tier-mapping failures (missing JdSignal fields) degrade to
tier='preferred' weighting (documented).

## Testing

Unit per module; evals (a)-(d); suite growth only; tsc; ROOT eslint;
ASCII; UK English; persona bump + manifest. Live validation: next JD run
shows networking theme facts + style-clean composed bullets.

## Consequences

- Required JD boxes drive theme selection for ANY JD; concept noise cannot
  outrank them.
- Composed bullets read as engineering narrative (what/concept/why/value)
  in public vocabulary for ANY user's codebase -- internal identifiers are
  structurally caught, not blocklisted.
- Curated-bullet style debt is made visible (advisories) and deferred to
  the case-study multi-angle loop, preserving byte-fidelity.
