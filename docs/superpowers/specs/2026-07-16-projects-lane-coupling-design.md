# Projects Lane Coupling: Unblock + Tune -- Design

**Date:** 2026-07-16
**Status:** Approved design -- pending implementation plan
**Driver:** Critical review of the Projects section in live run 1eda06eb
(MongoDB TSE JD). The projects agent's output has been schema-rejected in
three consecutive live runs (`unrecognized_keys: sources` on every
highlight), so only the JD-agnostic deterministic fallback has ever
shipped. The user's intended design -- resume generation USES user-created
projects (case-study/clustering origin), JD-customises each entry's
description, and surfaces the JD-relevant member-repo evidence inside its
parent project (e.g. kubernetes-bootstrap material inside "AI Applications
Platform with Infrastructure-as-Code") -- is already built and wired
(Phase 5 two-lane pool, `status <> 'archived'` selection, per-entry
description in the agent contract); it has simply never survived
validation to reach a resume.

**User decisions (locked):**
- One branch, all four components; next JD A/B validates the whole lane.
- Tolerance semantics: accept-and-discard extras (bulletId authoritative);
  real violations stay fail-closed.
- Resume generation NEVER creates projects; it uses the user's active
  projects only (already true -- preserved as an invariant, now stated).

## Root cause (Component 1 context)

The wire schema and the runtime schema disagree. The forced-tool schema
(`PROJECTS_EMIT_INPUT_SCHEMA`, projects-schema.ts) declares highlight items
as ONE flat object where `bulletId`, `text`, and `sources` are all legal
sibling properties (no oneOf, no additionalProperties:false, no per-item
required) -- constrained decoding permits filling all three. The runtime
zod then enforces a strict XOR union (`{bulletId}` | `{text, sources}`,
both `.strict()`), so any echo rejects the ENTIRE output. The sibling
experience lane REQUIRES `sources` on every bullet, so the same model is
applying the pipeline's own provenance culture where this one schema
forbids it. Economics today: the full generation (JD-customised
descriptions, composed repo-current bullets, selection) is paid for and
100% discarded, three runs running; the echoed keys themselves cost a few
tokens per bullet.

## Component 1 -- Highlight schema tolerance (the unblocking fix)

Files: `agents/writer/projects-schema.ts`, `agents/writer/projects-agent.ts`
(or the parse site), `agents/writer/projects-agent-diagnostics.ts`.

- New deterministic `normaliseProjectsAgentOutput(raw)` runs BEFORE zod
  validation:
  - item has non-empty `bulletId` -> curated: DROP any echoed `text` /
    `sources` / unknown keys (id authoritative; the SYSTEM assembles the
    final text from the pool, so a tampered or hallucinated echo can never
    reach the resume -- quote fidelity by construction);
  - item lacks `bulletId` but has `text` + non-empty `sources` -> composed:
    drop unknown keys;
  - item with neither shape -> left as-is (zod still rejects it -- hard
    failure preserved).
  - Returns `{ output, normalisedExtras }` where `normalisedExtras` counts
    items that needed stripping.
- Fail-closed boundary UNCHANGED: unknown bulletId, sources that do not
  resolve to the entry's OWN pool, `cross_project_citation`, and
  pool-empty invention all still reject to the deterministic fallback
  (projects-provenance rules untouched).
- Wire-schema hygiene (economy, not control): `PROJECTS_EMIT_INPUT_SCHEMA`
  highlight items get the two shapes stated in the tool/property
  descriptions ("curated = bulletId ONLY; composed = text + sources") so
  the echo habit is discouraged at source. The normaliser remains the
  control (enforcement at the dispatch boundary beats prompt wording --
  standing guardrail).
- Diagnostics: `normalisedExtras` (bounded int) added to the projectsAgent
  metadata block + the existing Loki event stream; watch it trend to zero.

## Component 2 -- Term-rule v2 ported to the projects lane

Files: `agents/writer/projects-ats-flow.ts` (coverage scoring),
`agents/evidence/project-agent-inputs.ts` or the fallback ranking site
(`buildProjectPool` / deterministic fallback ranking), reusing
`experienceTermMatch` from `ats/gate/experience-coverage.ts` (shipped
PR #492) -- no new matching logic.

- The agent lane's ATS target coverage scoring and the deterministic
  fallback's curated-bullet ranking both switch from strict
  adjacent-phrase matching to `experienceTermMatch` (emphasis-strip +
  light stemming + matchTier1). One matching truth across the experience
  and projects lanes.
- Summary lane's strict scorer stays untouched (locked Phase 3 decision);
  `ats/matching/keyword-match.ts` untouched.

## Component 3 -- Projects length honesty

Files: `ats/length/length-budget.ts` (+ tests).

- `measureResume` counts project HIGHLIGHT words in the projects measure
  (today only `description` is counted -- the 12-bullet, ~330-word
  overflow in run 1eda06eb was invisible to the whole length system).
- Budgets: `projectsWords` (160) continues to bound descriptions;
  new `projectsHighlightWords: 180` bounds the highlights total; the
  combined figure joins the total-words arithmetic.
- Enforcement mirrors the experience lane's whole-unit rule: agent
  contract carries the per-entry bullet cap (existing <= 2 composed +
  curated selection); `hardTrimProjects` additionally drops WHOLE
  highlight bullets from the end (least JD-relevant last, given
  Component 4 ordering) until within `projectsHighlightWords` -- never
  mid-bullet truncation of a curated quote (fidelity).
- The condense prompt's projects target line includes the highlights
  budget so the LLM direction and the deterministic backstop agree.

## Component 4 -- JD-aware ordering + pitch dedupe (generation contract)

Files: `prompts/content/strategist/projects-agent.md` (version bump +
manifest regeneration via the prompt-content-integrity suite),
`agents/writer/projects-message.ts`, fallback ordering site.

- Agent message + persona gain two rules: (1) order entries most-JD-
  relevant first; (2) the description must NOT restate the entry's own
  highlights (pitch = what it is / who it serves / the problem, plus ONE
  JD-relevant differentiator; facts used in bullets stay in bullets) --
  moving the `project_restates_bullets` class into the generation
  contract instead of post-hoc repair.
- The deterministic fallback mirrors the ordering: entries sorted by their
  curated bullets' aggregate `experienceTermMatch` coverage of the ATS
  targets (Component 2's matcher), so even fallback output is JD-ordered.

## Explicit invariants (restated, not new work)

- Resume generation never creates, renames, or re-scopes a project; the
  entry set is exactly the user's `status <> 'archived'` projects.
- Member-repo evidence surfaces INSIDE its parent project entry via the
  existing two-lane pool (repo-current lane resolves repo -> repositories
  -> project_repositories membership); archived singleton projects
  (kubernetes-bootstrap, tucaken-app, cdk-monitoring rows) remain filtered
  out and untouched.

## Error handling

Every component fails open to today's behaviour: normaliser is pure (a
malformed raw payload just falls through to the existing zod rejection +
fallback); matcher port cannot throw (pure predicate); length additions
extend an existing fail-open stage; ordering rules degrade to current
order when coverage ties.

## Testing

- Unit: normaliser (live failure payload verbatim -> accepted with extras
  stripped and byte-identical assembled text; both-keys item -> curated;
  neither-shape item -> still rejected; unknown-id / cross-project /
  empty-pool still fail-closed), length measure + whole-bullet trim,
  fallback ordering, coverage scoring under the ported matcher.
- Evals (house rule -- prompt + scorer changes ship with evals): the run
  1eda06eb curated+sources case; a K8s-flavoured target set must rank the
  platform project's bullets above frontend-portfolio's in the fallback;
  description-restates-bullets rejection case; JD-custom description
  grounded (no invention) case.
- Gates: full suite green (growth only from 152/1297), tsc, ROOT eslint,
  ASCII, UK English, prompt manifest regenerated for the persona bump.
- Live validation: next JD A/B expects `fallback.fired: false` for the
  projects agent for the first time, `normalisedExtras` observed, composed
  `[p{i}.r{k}]` bullets present, and a bounded Projects section.

## Consequences

- The projects lane's designed behaviour (user projects + JD-custom
  descriptions + member-repo evidence selection) ships for the first time;
  the three-run token waste stops (tolerance keeps the paid-for output).
- Matching truth is shared across experience and projects lanes; the
  length system finally sees the whole Projects section.
