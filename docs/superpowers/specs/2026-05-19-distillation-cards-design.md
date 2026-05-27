# SP1 — Distillation Cards — Design

**Date:** 2026-05-19
**Status:** Approved (design); pending implementation plan
**Parent initiative:** Profile Intelligence (6 features). This is **SP1 of SP0–SP5**.
SP0 (Profile Aggregation Foundation) shipped (PR #11). SP1 is the first
user-facing feature. SP2–SP5 remain separate later spec→plan→build cycles.

**Repo:** Entirely **tucaken-app** (admin-api + Next.js frontend). No
`ai-applications` change, **no DB migration** (columns already exist), **no
Bedrock/LLM** (highlights already extracted).

## Problem

Engineers describe their own projects badly. The data already holds the cure:
`repository_profiles.extracted` (written by `ai-applications` ProfileExtractor)
contains, per repo, `project_name`, `one_liner`, `description`, and
`highlights[]` — up to 5 grounded, ≤280-char, "resume bullets in waiting"
(ProfileExtractor system rule 7, enforced "do NOT invent metrics"). None of
this is surfaced to the user. SP1 presents it as a per-repo **Distillation
card** with a "Use in resume" toggle, in the onboarding aha sequence and on the
home/profile view.

## Decisions (locked during brainstorming)

| Decision | Choice |
|---|---|
| Bullets | Show all `highlights` (1–5) verbatim. **No LLM pass.** |
| Surface | One shared `DistillationCard`, mounted in a new onboarding step **and** a refactored user-home `RepoProfileCards`. |
| Toggle persistence | Reuse existing unused `repository_profiles.is_featured` (+ `feature_rank`). No migration. |
| API | Extend existing `GET /connected-repos` (+`highlights`,`isFeatured`,`featureRank`,`isHidden`) + one new write route. |
| Card filter | `classification='project' && !isHidden && extractionStatus='completed'` (same aggressive filter as SP0). |
| Architecture | Approach A — minimal vertical slice, shared card, max reuse. |

## Architecture & Boundaries

```
admin-api (tucaken-app/admin-api/src/routes/github.ts)
  GET  /connected-repos          extend SELECT + response map
  PATCH /connected-repos/:owner/:repo/featured   NEW write route

frontend (tucaken-app/src)
  lib/types/github.types.ts                ConnectedRepo += highlights/isFeatured/featureRank/isHidden
  features/github server fn + useToggleRepoFeatured mutation hook
  features/.../components/DistillationCard.tsx     NEW shared card
  features/user-home/components/RepoProfileCards.tsx   refactor RepoCard → reuse DistillationCard
  features/onboarding/.../types.ts + useOnboardingState.ts + onboarding.tsx
       + components/steps/DistillStep.tsx     NEW step 'distill'
  shared selector selectDistillableRepos()
```

Isolation mirrors the existing `insertRepository` helper: explicit
`WHERE user_id = $1::uuid` + `requireUserId(ctx)`. The admin-api DB role
already reads `repository_profiles` this way (no `set_config` in routes — do
not introduce one).

## Backend — `admin-api/src/routes/github.ts`

### Extend `GET /connected-repos`
The handler already LEFT JOINs `repository_profiles p`. Add to the SELECT:

```sql
p.extracted->'highlights'  AS highlights,
p.is_featured              AS is_featured,
p.feature_rank             AS feature_rank,
p.is_hidden                AS is_hidden,
```

Add to the response-map object:

```ts
highlights: r.highlights ?? null,      // string[] | null (jsonb auto-parsed)
isFeatured: r.is_featured ?? false,
featureRank: r.feature_rank ?? null,
isHidden:   r.is_hidden ?? false,
```

No other change to the query, ordering, or existing fields.

### New `PATCH /connected-repos/:owner/:repo/featured`
- Params `owner`,`repo`; reconstruct `repoFullName = `${owner}/${repo}``,
  validate against the existing `^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$` pattern
  (400 `{ error: '"owner/repo" must match owner/repo' }` on fail).
- Body `{ useInResume: boolean }`, zod
  `z.object({ useInResume: z.boolean() })`; non-JSON → 400
  `{ error: 'Body must be valid JSON' }`; zod fail → 400 with the error.
- `uid = requireUserId(ctx)`; missing → 401
  `{ error: 'Authenticated subject missing' }`.
- Enable (`useInResume === true`):

```sql
UPDATE repository_profiles
   SET is_featured = TRUE,
       feature_rank = COALESCE(
         (SELECT MAX(feature_rank) + 1 FROM repository_profiles
           WHERE user_id = $1::uuid AND is_featured = TRUE), 0)
 WHERE user_id = $1::uuid AND repo_full_name = $2
```

- Disable (`false`): `SET is_featured = FALSE, feature_rank = NULL WHERE …`.
- `rowCount === 0` → 404 `{ error: 'Profile not found for repo' }`.
- Success → 200 `{ repoFullName, isFeatured, featureRank }` (re-select or
  return the written values).
- Mirrors the `insertRepository` parameterised-query idiom and the existing
  JSON-body / regex-validation / error-shape conventions in this file.

> `feature_rank` is append-on-enable (`MAX+1`, base `0`), cleared on disable.
> Gaps from disables are acceptable — ordering only needs to be monotonic, not
> dense. Drag-reorder is explicitly out of scope (future SP).

## Frontend

- **`src/lib/types/github.types.ts`** — extend `ConnectedRepo`:
  `readonly highlights?: string[] | null`, `readonly isFeatured?: boolean`,
  `readonly featureRank?: number | null`, `readonly isHidden?: boolean`.
- **Server fn** (beside `triggerGitHubIngestionFn`):
  `setRepoFeaturedFn = createServerFn({ method: 'POST' })
   .inputValidator(z.object({ repoFullName: z.string().min(1),
   useInResume: z.boolean() }))
   .handler(async ({ data }) => { await requireAuth(); return apiFetch(
   `/github/connected-repos/${data.repoFullName}/featured`,
   { method: 'PATCH', body: JSON.stringify({ useInResume: data.useInResume }) }); })`.
  (`repoFullName` is `owner/repo`; the path interpolates it directly — the
  admin-api route reads `:owner/:repo`.)
- **`useToggleRepoFeatured`** mutation hook (mirrors the existing
  `RepoProfileCards` `useMutation`): `mutationFn` → `setRepoFeaturedFn`,
  `onSuccess` → `queryClient.invalidateQueries({ queryKey:
  adminKeys.github.connectedRepos() })`. No optimistic update (deferred;
  invalidation suffices).
- **`DistillationCard`** (`src/features/.../components/DistillationCard.tsx`),
  props `{ readonly repo: ConnectedRepo }`. Renders:
  - title = cleaned `repo.name` (repo slug; underscores/hyphens → spaced,
    title-cased — a small pure `cleanRepoTitle(name)` helper, unit-tested);
  - `repo.oneLiner` (omit if null);
  - `repo.highlights` as a `<ul>` of 1–5 bullets (render nothing if empty/null);
  - tech chips from `[...new Set(repo.techStack ?? [])]` (existing chip style);
  - a "Use in resume" toggle (switch/checkbox) bound to `repo.isFeatured`,
    `onChange` → `useToggleRepoFeatured`, disabled while the mutation is
    pending. Purely presentational + that one mutation; Tailwind reuses the
    existing card idiom.
- **Refactor `RepoProfileCards.tsx`** — `RepoCard` composes `DistillationCard`
  for the resume section while keeping its existing classification badge,
  sync-status footer, and re-index control. The connected-repos list behavior
  is otherwise unchanged.

## Onboarding Integration

- Add step id `distill` to `STEPS`
  (`src/features/onboarding/components/onboarding/types.ts`) and `STEP_INDEX`
  (`useOnboardingState.ts`), positioned **after `processing`, before
  `review`** → `welcome, portfolio, resume, connect, repos, processing,
  distill, review`; `required: false`. `ID_BY_INDEX`/`STEP_INDEX` are derived
  from `STEPS`, so indices shift automatically — but **audit every hardcoded
  index constant** (e.g. `CONNECT_STEP_INDEX` in `onboarding.tsx`, any
  `STEP_INDEX.review` usage, `OnboardingProgress`) and update/keep them
  correct.
- **`DistillStep`** (`components/steps/DistillStep.tsx`), props mirror existing
  steps (`{ onNext, onBack }`): consumes `useGitHubConnectedRepos()`, renders
  `selectDistillableRepos(repos)` as `DistillationCard`s, with a `StepFooter`
  (Back/Next, Next always enabled — reviewing/toggling is optional). Empty
  filtered set → friendly "No resume-ready projects yet — connect more repos or
  re-index" state. Render it in the `onboarding.tsx` step switch and add it to
  `OnboardingProgress`.

## Filtering

Shared pure selector `selectDistillableRepos(repos: ConnectedRepo[])` =
`repos.filter(r => r.classification === 'project' && !r.isHidden &&
r.extractionStatus === 'completed')`. Used by both the onboarding step and the
refactored home list so "real work" is defined once (same predicate as SP0's
rollup scope). Unit-tested as a pure function.

## Testing

- **admin-api** (`__tests__/routes/github.test.ts` style — Hono app + mocked
  `userId` middleware + mocked pool):
  - `GET /connected-repos` response now includes
    `highlights/isFeatured/featureRank/isHidden`;
  - `PATCH …/featured` `useInResume:true` → `is_featured=true` + `feature_rank`
    = MAX+1 (assert the UPDATE SQL + params); `false` → `is_featured=false`,
    `feature_rank=null`; unknown repo (`rowCount 0`) → 404; bad body → 400;
    bad `owner/repo` → 400; missing user → 401.
- **frontend** (vitest, existing server-fn test idiom — mocked
  `createServerFn`/`requireAuth`/`fetch`):
  - `setRepoFeaturedFn` issues `PATCH /github/connected-repos/{owner}/{repo}/featured`
    with `{ useInResume }` and the auth header;
  - `selectDistillableRepos` pure filter table test (project-only, excludes
    hidden / non-completed / non-project);
  - `cleanRepoTitle` pure helper table test.
  `DistillationCard`/`DistillStep` are thin presentational composes — covered
  transitively by the selector + server-fn + helper tests; no new heavy
  component-test harness is introduced.

## Out of Scope

- Any LLM/Bedrock generation or re-distillation of bullets (highlights are
  used verbatim — locked decision).
- DB migration (reusing existing columns) or any `ai-applications` change.
- Drag-reorder / batch `feature_rank` rewrite (future SP if needed).
- Optimistic toggle UI (invalidation only; can be a later polish).
- The other features (Mirror/Reveal/Reconciliation/Direction/Diagnostic) —
  separate sub-projects consuming SP0's rollup and/or this card.
- Backfill: repos profiled before SP1 already have `highlights` in
  `extracted`; nothing to backfill. `is_featured` simply defaults `false`.
