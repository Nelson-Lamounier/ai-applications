# Editable pipeline outputs (cover letter + resume override) — design

**Date:** 2026-06-24
**Status:** approved (design)
**Repos:** ai-applications (one migration: `resume_override`) + tucaken-app (read prefer + endpoint + serialiser + drawer Save/Reset).

## Problem

The strategist pipeline produces a tailored **cover letter** and **resume** per job
application. These are immutable pipeline output (read from
`pipeline_runs.metadata.analysis.coverLetter` and `…tailoredResumeData` / the
persisted `resumes.content_json`). The user can OPEN the `ResumeBuilderApp` drawer
and edit both, but the drawer is **ephemeral** — edits go to localStorage/nowhere
and are discarded on close (`enterEphemeralMode()`); there is no save path, so the
detail view + PDF download always re-render the original generated output. We want
the user to edit either output and have the edit persist and be served thereafter,
without mutating pipeline provenance.

Migration 103 already added `job_applications.cover_letter_override JSONB NOT NULL
DEFAULT 'null'`. There is no resume override column yet.

## Decisions (locked)

1. **Save from the drawer.** Add **Save changes** + **Reset to generated** to the
   existing `ResumeBuilderApp` drawer — the production editor for both outputs.
2. **Canonical shape, prefer-on-read.** The override stores the SAME shape the
   pipeline produces (`CoverLetter` / `ResumeData`), so every consumer (detail
   render, PDF download) is unchanged. The detail read returns
   `override ?? pipeline` for each. Server validates the shape before persisting.
3. **One combined endpoint.** `PATCH /applications/:slug/overrides
   { coverLetterOverride?, resumeOverride? }` — both saved in one round-trip; a
   field set to `null` resets THAT output to the generated version.

## Canonical shapes (the contract)

- `CoverLetter` (`src/lib/types/applications.types.ts:505`):
  `{ greeting: string; paragraphs: string[]; signoff: { name, email, linkedin, github } }`.
- `ResumeData` (`src/lib/resumes/resume-data.ts:54`):
  `{ profile, summary, keyAchievements[], experience[], certifications[], skills[], education[], projects[], sectionOrder? }`,
  where `experience[].highlights: string[]` are the bullets.

## The serialiser (the core unit + main risk)

The drawer's in-memory state (`AppState` in `resume-theme/app/state.tsx`) uses
BUILDER shapes that diverge from canonical: the cover letter is flat
(`CoverLetterData { greeting, body: string, closing }` — no structured `signoff`),
and resume experience uses `bullets` not `highlights`. The forward adapter
`mapApplicationToBuilderState` (`src/features/applications/utils/resume-adapters.ts:40`)
maps canonical -> builder; there is **no reverse**.

A new pure unit `serialiseBuilderToCanonical(builderState, original)` produces the
canonical `{ coverLetter, resume }` to persist, by **MERGING builder edits onto the
ORIGINAL canonical output** rather than reconstructing from scratch:

- **Cover letter:** `greeting` <- builder `cover.greeting`; `paragraphs` <- split
  builder `cover.body` on blank lines (one paragraph per block, trimmed, empties
  dropped); `signoff` <- **carried verbatim from the original** `CoverLetter.signoff`
  (the builder does not model it, so it must be preserved, not invented).
- **Resume:** map builder `ResumeData` back to canonical — `experience[].bullets`
  -> `experience[].highlights`, and any canonical fields the builder does not expose
  (e.g. `sectionOrder`, profile sub-fields) carried from the original. Reuse the
  inverse of `mapApplicationToBuilderState`'s field mapping.

`original` is the application's current generated output (already loaded into the
drawer). Because the merge starts from the original, non-editable structured data is
never lost. The unit is pure + unit-tested with round-trip cases
(`mapApplicationToBuilderState` then `serialiseBuilderToCanonical` preserves
signoff + structure; edited greeting/body/bullets are reflected).

## Components

### ai-applications
1. **Migration** `104_application_resume_override.sql` (104 = next free after 103;
   re-verify the highest committed number on develop at implementation time):
   `ALTER TABLE job_applications ADD COLUMN IF NOT EXISTS resume_override JSONB NOT
   NULL DEFAULT 'null'::jsonb;` — mirrors 103 (idempotent, BEGIN/COMMIT, no new RLS;
   `job_applications` is already owner-scoped).

### tucaken-app — admin-api
2. **Detail read prefers overrides** (`admin-api/src/routes/applications.ts`): the
   detail query (the `pipeline_runs` metadata SELECT around :356) also selects
   `cover_letter_override` + `resume_override` from `job_applications`. At the
   assembly point (:467 / :470): `coverLetter: coverLetterOverride ?? rawAnalysis['coverLetter'] ?? null`
   and `tailoredResume: resumeOverride ?? persistedResume ?? rawAnalysis['tailoredResumeData'] ?? null`.
   (`?? null` semantics: the columns default to JSON `null`, read as SQL non-null
   JSONB whose value is `null` — treat JSON-null as "no override". Use a helper that
   maps JSON `null` -> JS `null`.)
3. **Combined override endpoint** `PATCH /applications/:slug/overrides`
   (`routes/applications.ts`): body `{ coverLetterOverride?: CoverLetter | null;
   resumeOverride?: ResumeData | null }`. Each present field is Zod-validated against
   its canonical schema (or `null`); persisted via `withUser(getPool(config),
   userId, …)` (owner RLS, `SET LOCAL ROLE tucaken_app`) using new repository fns
   `updateCoverLetterOverride(db, applicationId, value)` +
   `updateResumeOverride(db, applicationId, value)` (each `UPDATE job_applications
   SET <col> = $2::jsonb WHERE id = $1`). An absent field is left unchanged; an
   explicit `null` resets it. Mirrors the existing `updateApplicationAnnotations`
   pattern (`repositories/applications.ts:84`).

### tucaken-app — frontend
4. **Server fn + mutation hook:** `patchApplicationOverridesFn` in
   `src/server/applications.ts` (alongside `patchApplicationAnnotationsFn`) ->
   `PATCH /applications/:slug/overrides`; `useSaveApplicationOverrides()` in
   `src/hooks/use-admin-applications.ts` invalidating
   `adminKeys.applications.detail(slug)` on success.
5. **Drawer Save/Reset UX** (`src/features/resume-theme/app/main.tsx`): add a
   **Save changes** button — on click, `serialiseBuilderToCanonical(state, original)`
   then call the mutation with both overrides; on success, toast + the invalidated
   detail query re-renders the saved output. Add **Reset to generated** — calls the
   mutation with `{ coverLetterOverride: null, resumeOverride: null }` and reloads the
   drawer from the (now generated) detail. These appear only in the
   application-drawer (ephemeral) context, not the standalone builder. The existing
   **Publish** + **Download** buttons are unchanged.
6. **Serialiser unit** `serialiseBuilderToCanonical` in
   `src/features/applications/utils/resume-adapters.ts` (next to the forward adapter)
   + its unit test.

## Data flow

```text
drawer edits (builder AppState, ephemeral)
  -- Save -->
  serialiseBuilderToCanonical(state, original) -> { coverLetter, resume }   [canonical, merged onto original]
  -> useSaveApplicationOverrides -> PATCH /applications/:slug/overrides
       -> Zod-validate each field -> withUser -> UPDATE job_applications SET cover_letter_override / resume_override
  -> invalidate applications.detail(slug)
       |
       v  (detail read)
  coverLetter  = cover_letter_override ?? pipeline.coverLetter
  tailoredResume = resume_override ?? persistedResume ?? pipeline.tailoredResumeData
  -> render + PDF download serve the edited version

Reset -> PATCH { coverLetterOverride: null, resumeOverride: null } -> columns back to JSON null -> read falls back to generated
```

## Error handling / safety

- **Validation:** each override field is validated against its canonical Zod schema
  before persistence; an invalid body is 400, nothing is written. A malformed
  override can never be stored.
- **RLS:** the endpoint writes only via `withUser(...)` (owner-scoped, the same
  `SET LOCAL ROLE tucaken_app` + `app.current_user_id` path as status/annotations);
  `:slug` resolves to the caller's application id under that context. No new policy.
- **No provenance mutation:** overrides live on `job_applications`; the pipeline
  output (`pipeline_runs.metadata`, `resumes.content_json`) is never modified.
- **Reset is non-destructive:** nulling the override reverts to the generated output;
  the original was never overwritten.
- **Additive + back-compat:** both columns default to JSON `null`; an application
  with no override behaves exactly as today.
- **Signoff preservation:** the serialiser carries the original `signoff` (and other
  non-builder fields) so a Save never drops structured data the builder can't edit.

## Testing

- **ai-app:** migration adds the column (idempotent), like 103.
- **serialiser (unit, the priority):** round-trip `mapApplicationToBuilderState` ->
  `serialiseBuilderToCanonical` preserves `signoff` + non-builder fields; an edited
  `cover.greeting`/`cover.body` yields the new `greeting`/`paragraphs[]`; an edited
  experience bullet yields the new `highlights[]`; empty paragraphs are dropped.
- **admin-api endpoint:** valid cover-letter-only / resume-only / both bodies persist
  the right column(s) via `withUser`; `null` resets; an invalid shape is 400 and
  writes nothing; an absent field is left unchanged.
- **admin-api read:** detail returns the override when the column is non-null JSON,
  else the pipeline value; JSON-null is treated as no override.
- **frontend:** the Save mutation posts the serialised canonical payload + invalidates
  the detail query; Reset posts nulls; the drawer reflects the result.

## Out of scope

- Editing any pipeline output other than cover letter + resume.
- Versioning / history of overrides (single current override per output; Reset
  discards).
- Changing the strategist pipeline, the `resumes` table, or the Publish flow.
- A standalone (non-drawer) cover-letter editor (the orphaned `CoverLetterForm` stays
  unused; remove it only if it becomes dead-weight in a future cleanup — out of scope
  here).
