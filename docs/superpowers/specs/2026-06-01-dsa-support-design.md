# DSA Support for the Technical Stage — Design (v1)

> **Date:** 2026-06-01
> **Status:** Approved design (brainstorming complete). Implementation plan next.
> **Goal:** Calibrate which DSA topics matter for a specific role, and frame honest
> gaps — without becoming a practice platform. v1 = JD calibration + honest gaps;
> real-work→DSA evidence (GitHub scanning) + practice-repo recognition are **v1.5**.
> **Repos:** `ai-applications` (ontology, JD calibration, coach) + `tucaken-app` (admin-api + UI).
> **Design input:** `docs/superpowers/specs/2026-06-01-dsa-support-design-input.md` (5-surface
> review workflow + 2 adversarial verdicts).
> **Builds on:** Spec 1 (stage-prep ontology), Spec 2a (coach prep), Spec 2b (stage triggering).

## Why DSA is different (the structural fact)

System design lives in production work → visible in GitHub → the KB/tech-extractor reads it.
**DSA lives in practice work (LeetCode etc.) → not in production code.** No better repo
parsing surfaces DSA practice, because it doesn't happen in production. So DSA needs a
different treatment: Tucaken's role is **calibration** (which topics matter for THIS role),
**honest gap acknowledgment** (point to external practice), and — later (v1.5) — **surfacing
the rare real-work patterns** that map to DSA topics. Tucaken does NOT generate practice
problems, run mock interviews, or tutor — that category is mature (LeetCode/NeetCode) and
generating it would dilute the evidence-based positioning.

## Adversarial verdicts carried as hard constraints (from the review)

1. **Ontology = constraint, never content.** Seed topic taxonomy + JD-signal mappings + gap
   templates. NEVER example problems, solutions, study plans, or difficulty banks.
2. **No semantic GitHub detection in v1** (and even in v1.5, only high-precision import/type
   signals). A `for`-loop ≠ DP; recursion ≠ recursive descent. v1 ships **no** code-scan, so
   Section B cannot claim "your work shows X" — it only says "this role tests X; practice here."

## Scope decisions (locked)

- **Defer the GitHub DSA detector to v1.5** (separate spec, gated on an FP ≤ 5% hand-inspection).
- **Dedicated `dsa_topics` table** (not a `technology_ontology` category) — DSA topics are
  concepts, not installable technologies; keep them out of the skill-graph/KB-quality consumers.
- **Per-stage `round_type`** in `process_shape` (handles multi-round companies; default `'dsa'`).

## Components

### A. `dsa_topics` ontology (`ai-applications`) — constraint-only reference data

**Migration `051_dsa_topics.sql`** (mirrors `049_stage_prep_ontology.sql`: global, no `user_id`,
no RLS, idempotent `INSERT … ON CONFLICT`, frozen-snapshot header with cited sources):

```sql
CREATE TABLE IF NOT EXISTS dsa_topics (
  canonical_name    TEXT PRIMARY KEY,          -- 'dsa_graph_traversal'
  display_name      TEXT NOT NULL,             -- 'Graph traversal (BFS/DFS)'
  category          TEXT NOT NULL,             -- 'graphs','dynamic_programming','trees','arrays_strings','hashing','heaps','concurrency','sorting','recursion'
  jd_signal_keywords JSONB NOT NULL DEFAULT '[]'::jsonb,  -- ['dependency','graph','shortest path','ranking']
  prerequisites     JSONB NOT NULL DEFAULT '[]'::jsonb,   -- ['dsa_recursion','dsa_memoization']
  practice_pointer  TEXT,                       -- a LeetCode/NeetCode TAG or URL — a pointer, not content
  source            TEXT NOT NULL,              -- 'Tech Interview Handbook / NeetCode topic taxonomy, retrieved 2026-06-01'
  as_of             DATE NOT NULL
);
```

Seed ~60–80 canonical topics across the categories, each with `jd_signal_keywords` (drives §B),
a `practice_pointer`, and cited `source`/`as_of`. **Never seed** problems/solutions/plans.

New `RdsDsaTopicRepository` (shared, mirrors `RdsStagePrepOntologyRepository`): `listTopics()`,
`listByCategory(cat)`. DSA 🔴 gap-handling **reuses `prep_scaffolds(kind='gap_handling')`**;
add 1–2 DSA-specific gap templates to that seed ("haven't drilled X on LeetCode, but…").

### B. JD → DSA calibration (`ai-applications` research agent)

Extend the research agent's structured output with `dsaTopicCalibration` on
`StrategistResearchResult`:

```typescript
readonly dsaTopicCalibration?: {
  readonly likelyTopics: ReadonlyArray<{
    readonly canonicalName: string;   // resolves to dsa_topics
    readonly displayName: string;
    readonly confidence: number;      // JD-inference confidence [0,1]
    readonly rationale: string;
    readonly jdEvidenceQuote: string; // the JD phrase that implied it
  }>;
  readonly honestyNote: string;       // mandatory: "inferred from JD language, not guaranteed"
}
```

The agent loads `dsa_topics` (name + `jd_signal_keywords`) and matches the JD against them +
model judgment, emitting the prioritized topic set. Persisted in `pipeline_runs.metadata.research`
(already served by `GET /:slug`). A senior-platform JD with no DSA signal yields an empty
`likelyTopics` (→ Section B shows "this role likely has no DSA round").

### C. Per-stage `round_type` (`ai-applications` + `admin-api`)

`ProcessStage` (`applications/shared/src/stage-prep/stage-prep-types.ts`) gains
`round_type?: 'dsa' | 'practical' | 'take-home' | 'system-design' | 'behavioral' | 'mixed'`.
It lives inside `company_interview_profiles.process_shape` (JSONB) — **no migration**; update the
type + re-seed company profiles' `process_shape` entries with `round_type`, cited provenance
(Glassdoor / eng blogs, same discipline as comp benchmarks). `GET /:slug` resolves the app's
company → exposes the **technical** stage's `round_type` (default `'dsa'` safe-mode when the
company/round is unknown — never silently hide DSA).

### D. Technical workspace Section B (`tucaken-app`)

Below Section A (system design), gated on `round_type ∈ {dsa, mixed, practical}` (suppressed for
`take-home`/`system-design`). v1 cards come from `detail.research.dsaTopicCalibration`:
- Each card = a JD-implied topic: `displayName`, relevance (confidence), `rationale`.
- **v1 evidence model (honest by omission):** no GitHub DSA evidence exists yet, so cards do NOT
  render 🟢/🟡 from real work. Each shows a **"matters for this role → practice externally"**
  treatment: the `practice_pointer` link + a gap-acknowledge template from `prep_scaffolds`.
- **Data-sources banner** (top of Section B): "We calibrate which DSA topics matter for this role
  and flag gaps. DSA practice happens off-GitHub — we point you to LeetCode/NeetCode; we don't
  drill. (Real-work pattern detection is coming.)"
- The full 🟢/🟡/🔴 model is wired so v1.5 can light up 🟢/🟡 once GitHub/practice-repo evidence
  lands — but v1 ships the 🔴/relevance treatment only.
- `practical` round_type → relaxed framing (real-work + ship-ready emphasis, no complexity drills).

UI types: add `DsaTopicCalibration` + the technical `roundType` to `ApplicationDetail`
(`src/lib/types/applications.types.ts`).

### E. Coach DSA-awareness (`ai-applications`)

`buildStagePrepConstraintBlock` — for technical stages, append the calibrated DSA topics
(`dsaTopicCalibration.likelyTopics`) + the `round_type` to the constraint text, so coach prep
reflects the round shape (e.g. emphasizes DSA topic prep, or de-emphasizes for `take-home`).
Text-only; no `CoachAgentInput` schema change. Reuses the existing constraint-block injection.

## Data flow

```
seed: dsa_topics (051) + company process_shape round_type re-seed
analysis (per app): research agent matches JD × dsa_topics.jd_signal_keywords
  → research.dsaTopicCalibration (persisted in pipeline_runs.metadata.research)
GET /:slug → research.dsaTopicCalibration + technical round_type (resolved from company profile)
Technical workspace → Section B gated by round_type; cards from dsaTopicCalibration;
  honest "practice externally" framing + banner
coach (technical stage) → constraint block includes DSA topics + round_type
```

## Error handling & honesty guardrails
- No `dsa_topics` match / no JD signal → empty `likelyTopics` → Section B says "no DSA round
  likely for this role" (never invents topics).
- `round_type` unknown → default `'dsa'` (over-show, never hide).
- v1 has **zero** GitHub DSA evidence → Section B never claims real-work DSA competence (honest by
  omission). `honestyNote` mandatory on the calibration.
- Ontology stores constraint only — no problems/solutions/plans.
- The existing `PracticeModal` generate/mock affordances are **demoted to external pointers** (no
  in-product practice generation) — aligns the UI with the positioning.

## Testing
- **A:** migration applies; `RdsDsaTopicRepository` list/by-category (fakePool); seed row counts > 0.
- **B:** research agent emits `dsaTopicCalibration` (schema accepts present/empty); JD with DSA
  signal → topics; senior-platform JD → empty. Honesty note present.
- **C:** `round_type` round-trips through `process_shape`; `GET /:slug` exposes technical round_type;
  default 'dsa' when absent.
- **D:** Section B gated by round_type (shown for dsa/mixed/practical, hidden for take-home/SD);
  cards render from calibration; banner present; no fake 🟢.
- **E:** constraint block includes DSA topics + round_type for technical stage.
- **E2E (manual):** an app with a FAANG-style JD → Section B lists calibrated topics + practice
  pointers; a senior-platform JD → "no DSA round likely".

## Decomposition (2 PRs)
- **PR1** (`ai-applications`): `dsa_topics` migration 051 + seed + `RdsDsaTopicRepository`; research
  agent `dsaTopicCalibration`; `ProcessStage.round_type` type + company re-seed; coach constraint
  DSA-awareness; DSA gap templates in `prep_scaffolds` seed.
- **PR2** (`tucaken-app`): admin-api serves `dsaTopicCalibration` + technical `round_type` in detail;
  Technical workspace Section B + honest framing + banner + types; demote PracticeModal to pointers.

## Out of scope (v1)
- **v1.5:** GitHub DSA-pattern detector (5 high-precision import/type signals, FP ≤ 5% gate);
  practice-repo archetype recognition; DSA-tagged stories; the full 🟢/🟡 real-work evidence badges.
- **Defer indefinitely:** practice-problem generation, mock interviews, DSA tutoring, LeetCode API,
  the 15-regex detector set, any DSA content tables.
