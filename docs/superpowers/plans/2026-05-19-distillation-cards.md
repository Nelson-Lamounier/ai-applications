# SP1 — Distillation Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface each project repo as a "Distillation card" (title, one-liner, `highlights[]` bullets, tech chips, "Use in resume" toggle) reusing already-extracted data, shown in a new onboarding step and a refactored user-home card list.

**Architecture:** Entirely **tucaken-app**. admin-api: extend `GET /connected-repos` + one new `PATCH /connected-repos/:fullName/featured` write route (reuse the unused `repository_profiles.is_featured`/`feature_rank`). Frontend: extend `ConnectedRepo`, add a server fn + mutation hook, one shared `DistillationCard` mounted by a new onboarding `distill` step and a refactored `RepoProfileCards`. No DB migration, no Bedrock, no `ai-applications` change.

**Tech Stack:** TypeScript, Hono (admin-api), `pg`, Jest (admin-api, ts-jest ESM), Next/TanStack-Start + TanStack Query (frontend), Vitest (frontend), Zod, Tailwind.

Spec: `docs/superpowers/specs/2026-05-19-distillation-cards-design.md` (in the ai-applications repo's gitignored docs; this plan lives beside it).

**Environment (every task):** Work in an isolated **tucaken-app** worktree created at execution time. `WT=<worktree abs path>`. Shell cwd resets between commands; EVERY command self-contained. admin-api commands: `cd "$WT/admin-api" && yarn <script>`. Frontend commands: `cd "$WT" && yarn <script>` (repo root). Git: `git -C "$WT" …`. Confirm branch HEAD via `git -C "$WT" rev-parse HEAD`. Default branch: `main`. Git identity is the user's (Nelson Lamounier / lamounierleao@gmail.com) — **never** an AI identity.

All commits follow the **git-commit skill**: typecheck + relevant tests pass before commit; atomic staging of only the listed files (never `git add .`/`-A`); conventional message; **no `Co-Authored-By`/AI authorship trailer**.

**Route-id convention (important):** repo identifier in admin-api routes is a single `:fullName` param carrying URL-encoded `owner%2Frepo`, read via `decodeURIComponent(ctx.req.param('fullName'))` and validated with `/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/` (see `DELETE /connected-repos/:fullName`, `admin-api/src/routes/github.ts:795`). The spec's `:owner/:repo` wording is realized as this established `:fullName` convention.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `tucaken-app/admin-api/src/routes/github.ts` | `ConnectedRepoRow` + `listConnectedRepos` SELECT + GET map (add highlights/isFeatured/featureRank/isHidden); new `PATCH /connected-repos/:fullName/featured` | Modify |
| `tucaken-app/admin-api/__tests__/routes/github.test.ts` | Route tests for GET additions + PATCH | Modify |
| `tucaken-app/src/lib/types/github.types.ts` | `ConnectedRepo` += `highlights`/`isFeatured`/`featureRank`/`isHidden` | Modify |
| `tucaken-app/src/server/github.ts` | `setRepoFeaturedFn` server fn | Modify |
| `tucaken-app/src/features/github/hooks/use-toggle-repo-featured.ts` | `useToggleRepoFeatured` mutation hook | Create |
| `tucaken-app/src/features/github/lib/distill.ts` | `selectDistillableRepos`, `cleanRepoTitle` pure helpers | Create |
| `tucaken-app/src/features/github/lib/__tests__/distill.test.ts` | Pure-helper tests | Create |
| `tucaken-app/src/__tests__/server/github-set-featured.test.ts` | `setRepoFeaturedFn` vitest | Create |
| `tucaken-app/src/features/github/components/DistillationCard.tsx` | Shared presentational card | Create |
| `tucaken-app/src/features/user-home/components/RepoProfileCards.tsx` | Refactor `RepoCard` to compose `DistillationCard` | Modify |
| `tucaken-app/src/features/onboarding/components/onboarding/types.ts` | Add `distill` to `STEPS` + `StepId` | Modify |
| `tucaken-app/src/features/onboarding/components/onboarding/useOnboardingState.ts` | Add `distill` to `STEP_INDEX` | Modify |
| `tucaken-app/src/features/onboarding/components/steps/DistillStep.tsx` | New onboarding step | Create |
| `tucaken-app/src/app/onboarding.tsx` | Render `DistillStep`; audit hardcoded indices | Modify |
| `tucaken-app/src/features/onboarding/components/onboarding/OnboardingProgress.tsx` | Include the new step | Modify |

**Deliberate spec refinement:** spec said `PATCH /connected-repos/:owner/:repo/featured`; the codebase convention is `:fullName` URL-encoded. Plan uses `:fullName`. Same external behavior; documented here and in the self-review.

---

## Task 1: Extend `GET /connected-repos`

**Files:**
- Modify: `tucaken-app/admin-api/src/routes/github.ts` (`ConnectedRepoRow` ~line 133, `listConnectedRepos` SELECT ~155-164, GET map ~622-645)
- Modify: `tucaken-app/admin-api/__tests__/routes/github.test.ts`

- [ ] **Step 1: Write the failing test**

In `github.test.ts`, locate the existing GET `/connected-repos` test (or the `buildApp`/mocked-pool harness it uses; mirror the file's `jest.unstable_mockModule` + mocked-`userId` middleware pattern, same as `resume-imports.test.ts`'s `app.use('*', (c,next)=>{ c.set('userId', TEST_USER_ID); next() })`). Add a test asserting the mapped response now includes the new fields. Use the file's existing pool mock; make the profile row return `highlights`, `is_featured`, `feature_rank`, `is_hidden`:

```ts
it('GET /connected-repos exposes highlights/isFeatured/featureRank/isHidden', async () => {
  // arrange: pool mock returns one joined row including the new columns
  poolQueryMock.mockResolvedValueOnce({ rows: [{
    full_name: 'octo/app', default_branch: 'main', index_status: 'complete',
    added_at: new Date('2026-01-01T00:00:00Z'),
    sync_status: 'complete', last_synced_at: new Date('2026-01-02T00:00:00Z'),
    file_count: 3, chunk_count: 9, error_message: null,
    quality_score: 0.8, quality_breakdown: null, classification: 'project',
    extraction_status: 'completed', one_liner: 'A thing', domain: 'infra',
    tech_stack: ['AWS'], complexity: 'moderate', confidence: 0.9,
    highlights: ['Built X', 'Shipped Y'], is_featured: true,
    feature_rank: 2, is_hidden: false,
  }] });
  const app = buildApp();
  const res = await app.request('/connected-repos');
  expect(res.status).toBe(200);
  const body = await res.json() as { repos: Array<Record<string, unknown>> };
  expect(body.repos[0]).toMatchObject({
    repoFullName: 'octo/app',
    highlights: ['Built X', 'Shipped Y'],
    isFeatured: true, featureRank: 2, isHidden: false,
  });
});
```

> Adapt `poolQueryMock`/`buildApp` names to the actual harness in `github.test.ts`. Keep the four asserted fields.

- [ ] **Step 2: Run test, confirm FAIL**

Run: `cd "$WT/admin-api" && yarn test github.test.ts`
Expected: FAIL — response lacks `highlights/isFeatured/featureRank/isHidden`.

- [ ] **Step 3: Extend the SQL + row interface + map**

In `ConnectedRepoRow` (~line 133) add fields:

```ts
  highlights:    string[] | null;
  is_featured:   boolean | null;
  feature_rank:  number | null;
  is_hidden:     boolean | null;
```

In `listConnectedRepos`'s SELECT, after the existing `(p.extracted->>'confidence')::float AS confidence` line, add (keep the trailing comma placement valid):

```sql
,
                p.extracted->'highlights'             AS highlights,
                p.is_featured                         AS is_featured,
                p.feature_rank                        AS feature_rank,
                p.is_hidden                           AS is_hidden
```

In the GET `/connected-repos` response map (the `rows.map(r => ({ … }))` ~622-645), after `confidence: r.confidence ?? null,` add:

```ts
            highlights:  r.highlights  ?? null,
            isFeatured:  r.is_featured ?? false,
            featureRank: r.feature_rank ?? null,
            isHidden:    r.is_hidden   ?? false,
```

(`p.extracted->'highlights'` returns JSONB → `pg` auto-parses to a JS array.)

- [ ] **Step 4: Run test, confirm PASS**

Run: `cd "$WT/admin-api" && yarn test github.test.ts`
Expected: PASS (new test + all pre-existing github tests).

- [ ] **Step 5: Typecheck + commit**

Run: `cd "$WT/admin-api" && yarn typecheck`
Expected: PASS.

```bash
git -C "$WT" add admin-api/src/routes/github.ts admin-api/__tests__/routes/github.test.ts
git -C "$WT" commit -m "feat(admin-api): expose highlights and featured flags on connected-repos"
```

---

## Task 2: `PATCH /connected-repos/:fullName/featured`

**Files:**
- Modify: `tucaken-app/admin-api/src/routes/github.ts` (add route just before `return router;` ~line 808; mirror `DELETE /connected-repos/:fullName` at ~795 and the `insertRepository` query idiom at ~177)
- Modify: `tucaken-app/admin-api/__tests__/routes/github.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
describe('PATCH /connected-repos/:fullName/featured', () => {
  it('enables: sets is_featured + feature_rank = MAX+1', async () => {
    poolQueryMock.mockResolvedValueOnce({ rows: [{ feature_rank: 4 }], rowCount: 1 }); // UPDATE … RETURNING
    const app = buildApp();
    const res = await app.request('/connected-repos/octo%2Fapp/featured', {
      method: 'PATCH', body: JSON.stringify({ useInResume: true }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toMatchObject({ repoFullName: 'octo/app', isFeatured: true });
    const sql = String(poolQueryMock.mock.calls.at(-1)?.[0] ?? '');
    expect(sql).toMatch(/UPDATE repository_profiles/i);
    expect(sql).toMatch(/is_featured\s*=\s*TRUE/i);
    expect(poolQueryMock.mock.calls.at(-1)?.[1]).toEqual(
      expect.arrayContaining(['test-user', 'octo/app']));
  });

  it('disables: is_featured FALSE, feature_rank NULL', async () => {
    poolQueryMock.mockResolvedValueOnce({ rows: [{ feature_rank: null }], rowCount: 1 });
    const app = buildApp();
    const res = await app.request('/connected-repos/octo%2Fapp/featured', {
      method: 'PATCH', body: JSON.stringify({ useInResume: false }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ isFeatured: false, featureRank: null });
  });

  it('404 when no profile row matches', async () => {
    poolQueryMock.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const app = buildApp();
    const res = await app.request('/connected-repos/octo%2Fapp/featured', {
      method: 'PATCH', body: JSON.stringify({ useInResume: true }),
    });
    expect(res.status).toBe(404);
  });

  it('400 on bad body', async () => {
    const app = buildApp();
    const res = await app.request('/connected-repos/octo%2Fapp/featured', {
      method: 'PATCH', body: 'not json',
    });
    expect(res.status).toBe(400);
  });

  it('400 on bad repo name', async () => {
    const app = buildApp();
    const res = await app.request('/connected-repos/not-a-repo/featured', {
      method: 'PATCH', body: JSON.stringify({ useInResume: true }),
    });
    expect(res.status).toBe(400);
  });
});
```

> Adapt mock names to the harness. If the harness's mocked-userId middleware always injects `test-user`, the 401 path can't be exercised there — omit the 401 test (the code still implements it, consistent with sibling routes).

- [ ] **Step 2: Run test, confirm FAIL**

Run: `cd "$WT/admin-api" && yarn test github.test.ts`
Expected: FAIL — route not found (404 for all / wrong shapes).

- [ ] **Step 3: Add the route**

Insert immediately before `return router;` (the line after the `DELETE /connected-repos/:fullName` handler, ~line 808):

```ts
    // -------------------------------------------------------------------------
    // PATCH /connected-repos/:fullName/featured — toggle "use in resume"
    // :fullName is URL-encoded "owner%2Frepo" (same convention as DELETE)
    // -------------------------------------------------------------------------
    router.patch('/connected-repos/:fullName/featured', async (ctx) => {
        const pool = getPool(config);
        const uid  = requireUserId(ctx);
        if (!uid) return ctx.json({ error: 'Authenticated subject missing' }, 401);

        const repoFullName = decodeURIComponent(ctx.req.param('fullName'));
        if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repoFullName)) {
            return ctx.json({ error: 'Invalid repo name' }, 400);
        }

        let body: { useInResume?: unknown };
        try { body = await ctx.req.json(); }
        catch { return ctx.json({ error: 'Body must be valid JSON' }, 400); }
        if (typeof body.useInResume !== 'boolean') {
            return ctx.json({ error: '"useInResume" must be a boolean' }, 400);
        }
        const useInResume = body.useInResume;

        const sql = useInResume
            ? `UPDATE repository_profiles
                  SET is_featured = TRUE,
                      feature_rank = COALESCE(
                        (SELECT MAX(feature_rank) + 1 FROM repository_profiles
                          WHERE user_id = $1::uuid AND is_featured = TRUE), 0)
                WHERE user_id = $1::uuid AND repo_full_name = $2
            RETURNING feature_rank`
            : `UPDATE repository_profiles
                  SET is_featured = FALSE, feature_rank = NULL
                WHERE user_id = $1::uuid AND repo_full_name = $2
            RETURNING feature_rank`;

        const { rows, rowCount } = await pool.query<{ feature_rank: number | null }>(
            sql, [uid, repoFullName],
        );
        if (!rowCount) return ctx.json({ error: 'Profile not found for repo' }, 404);

        return ctx.json({
            repoFullName,
            isFeatured:  useInResume,
            featureRank: rows[0]?.feature_rank ?? null,
        });
    });

```

- [ ] **Step 4: Run test, confirm PASS**

Run: `cd "$WT/admin-api" && yarn test github.test.ts`
Expected: PASS (all PATCH cases + pre-existing).

- [ ] **Step 5: Typecheck + lint + commit**

Run: `cd "$WT/admin-api" && yarn typecheck` (PASS). Run: `cd "$WT/admin-api" && yarn lint` — if `eslint` is unresolved in the worktree (known tooling quirk), note it and rely on typecheck + tests; otherwise it must pass clean for `github.ts`.

```bash
git -C "$WT" add admin-api/src/routes/github.ts admin-api/__tests__/routes/github.test.ts
git -C "$WT" commit -m "feat(admin-api): add featured toggle route for resume distillation"
```

---

## Task 3: Frontend type + server fn + mutation hook

**Files:**
- Modify: `tucaken-app/src/lib/types/github.types.ts` (`ConnectedRepo`)
- Modify: `tucaken-app/src/server/github.ts` (add `setRepoFeaturedFn` beside `triggerGitHubIngestionFn`)
- Create: `tucaken-app/src/features/github/hooks/use-toggle-repo-featured.ts`
- Create: `tucaken-app/src/__tests__/server/github-set-featured.test.ts`

- [ ] **Step 1: Extend the type**

In `github.types.ts` `ConnectedRepo` interface, after `confidence?`:

```ts
  readonly highlights?:  string[] | null
  readonly isFeatured?:  boolean
  readonly featureRank?: number | null
  readonly isHidden?:    boolean
```

- [ ] **Step 2: Write the failing server-fn test**

Create `src/__tests__/server/github-set-featured.test.ts`, mirroring the existing server-fn test idiom (mock `@tanstack/react-start` `createServerFn`, `../../server/auth-guard` `requireAuth`, and global `fetch`; read a sibling like the existing github server-fn test for the exact mock scaffold):

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
vi.mock('@tanstack/react-start', () => ({
  createServerFn: () => {
    const chain: Record<string, unknown> = {}
    chain.middleware = () => chain
    chain.inputValidator = () => chain
    chain.handler = (fn: unknown) => fn
    return chain
  },
}))
vi.mock('../../server/auth-guard', () => ({
  requireAuth: vi.fn().mockResolvedValue({ id: 'u1', email: 't@e.com' }),
}))
const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)
const mockGetCookie = vi.fn().mockReturnValue('jwt')
vi.mock('@tanstack/react-start/server', () => ({ getCookie: mockGetCookie }))

import { setRepoFeaturedFn } from '../../server/github.js'

describe('setRepoFeaturedFn', () => {
  beforeEach(() => { vi.clearAllMocks(); mockGetCookie.mockReturnValue('jwt') })
  it('PATCHes the featured route with useInResume', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200,
      json: async () => ({ repoFullName: 'o/r', isFeatured: true, featureRank: 0 }),
      text: async () => '' })
    const handler = setRepoFeaturedFn as unknown as
      (a: { data: { repoFullName: string; useInResume: boolean } }) => Promise<unknown>
    const out = await handler({ data: { repoFullName: 'o/r', useInResume: true } })
    const [url, opts] = fetchMock.mock.calls[0]
    expect(String(url)).toMatch(/\/github\/connected-repos\/o%2Fr\/featured$/)
    expect((opts as { method: string }).method).toBe('PATCH')
    expect(JSON.parse((opts as { body: string }).body)).toEqual({ useInResume: true })
    expect(out).toMatchObject({ isFeatured: true })
  })
})
```

> Adjust the import paths/auth-guard mock to match the real scaffold used by the existing `src/__tests__/server/*github*` test. Keep the URL-encoding + method + body assertions.

- [ ] **Step 3: Run test, confirm FAIL**

Run: `cd "$WT" && yarn test src/__tests__/server/github-set-featured.test.ts`
Expected: FAIL — `setRepoFeaturedFn` not exported.

- [ ] **Step 4: Add the server fn**

In `src/server/github.ts`, beside `triggerGitHubIngestionFn` (same `createServerFn` + `apiFetch` idiom; reuse the file's existing `z` import and `apiFetch`):

```ts
const setRepoFeaturedSchema = z.object({
  repoFullName: z.string().min(1),
  useInResume:  z.boolean(),
})

export const setRepoFeaturedFn = createServerFn({ method: 'POST' })
  .inputValidator(setRepoFeaturedSchema)
  .handler(async ({ data }) => {
    await requireAuth()
    return apiFetch<{ repoFullName: string; isFeatured: boolean; featureRank: number | null }>(
      `/github/connected-repos/${encodeURIComponent(data.repoFullName)}/featured`,
      { method: 'PATCH', body: JSON.stringify({ useInResume: data.useInResume }) },
    )
  })
```

- [ ] **Step 5: Run test, confirm PASS**

Run: `cd "$WT" && yarn test src/__tests__/server/github-set-featured.test.ts`
Expected: PASS.

- [ ] **Step 6: Add the mutation hook**

Create `src/features/github/hooks/use-toggle-repo-featured.ts` (mirror the `useMutation` + invalidate idiom in `RepoProfileCards.tsx`):

```ts
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { setRepoFeaturedFn } from '../../../server/github.js'
import { adminKeys } from '../../../lib/api/query-keys.js'

export function useToggleRepoFeatured(repoFullName: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (useInResume: boolean) =>
      setRepoFeaturedFn({ data: { repoFullName, useInResume } }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: adminKeys.github.connectedRepos() }),
  })
}
```

> Verify the exact import specifier for `adminKeys` (`src/lib/api/query-keys.ts`) and `setRepoFeaturedFn` against how `RepoProfileCards.tsx` imports them; match its style (relative vs `@/` alias).

- [ ] **Step 7: Typecheck + commit**

Run: `cd "$WT" && yarn typecheck`
Expected: PASS.

```bash
git -C "$WT" add src/lib/types/github.types.ts src/server/github.ts src/features/github/hooks/use-toggle-repo-featured.ts src/__tests__/server/github-set-featured.test.ts
git -C "$WT" commit -m "feat(web): add setRepoFeatured server fn and toggle hook"
```

---

## Task 4: Pure helpers — `selectDistillableRepos`, `cleanRepoTitle`

**Files:**
- Create: `tucaken-app/src/features/github/lib/distill.ts`
- Create: `tucaken-app/src/features/github/lib/__tests__/distill.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { selectDistillableRepos, cleanRepoTitle } from '../distill.js'
import type { ConnectedRepo } from '../../../../lib/types/github.types.js'

function repo(p: Partial<ConnectedRepo> = {}): ConnectedRepo {
  return {
    repoFullName: 'o/r', owner: 'o', name: 'r', defaultBranch: 'main',
    syncStatus: 'complete', addedAt: '2026-01-01T00:00:00Z',
    classification: 'project', extractionStatus: 'completed', isHidden: false,
    ...p,
  } as ConnectedRepo
}

describe('selectDistillableRepos', () => {
  it('keeps only project + !hidden + completed', () => {
    const out = selectDistillableRepos([
      repo({ repoFullName: 'o/a' }),
      repo({ repoFullName: 'o/b', classification: 'fork' }),
      repo({ repoFullName: 'o/c', isHidden: true }),
      repo({ repoFullName: 'o/d', extractionStatus: 'pending' }),
    ])
    expect(out.map(r => r.repoFullName)).toEqual(['o/a'])
  })
})

describe('cleanRepoTitle', () => {
  it('humanizes the repo slug', () => {
    expect(cleanRepoTitle('my-cool_repo')).toBe('My Cool Repo')
    expect(cleanRepoTitle('API.gateway')).toBe('API Gateway')
    expect(cleanRepoTitle('x')).toBe('X')
  })
})
```

- [ ] **Step 2: Run test, confirm FAIL**

Run: `cd "$WT" && yarn test src/features/github/lib/__tests__/distill.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/features/github/lib/distill.ts`:

```ts
import type { ConnectedRepo } from '../../../lib/types/github.types.js'

/** Repos that earn a Distillation card: real project work only (matches SP0 scope). */
export function selectDistillableRepos(repos: ConnectedRepo[]): ConnectedRepo[] {
  return repos.filter(
    r => r.classification === 'project'
      && r.isHidden !== true
      && r.extractionStatus === 'completed',
  )
}

/** Repo slug → human title: split on - _ . and whitespace, title-case,
 *  but keep all-caps tokens (e.g. "API", "AWS") as-is. */
export function cleanRepoTitle(name: string): string {
  return name
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .map(w => (w === w.toUpperCase() ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ')
}
```

- [ ] **Step 4: Run test, confirm PASS**

Run: `cd "$WT" && yarn test src/features/github/lib/__tests__/distill.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `cd "$WT" && yarn typecheck`
Expected: PASS.

```bash
git -C "$WT" add src/features/github/lib/distill.ts src/features/github/lib/__tests__/distill.test.ts
git -C "$WT" commit -m "feat(web): add distillable-repo selector and title helper"
```

---

## Task 5: `DistillationCard` + refactor `RepoProfileCards`

**Files:**
- Create: `tucaken-app/src/features/github/components/DistillationCard.tsx`
- Modify: `tucaken-app/src/features/user-home/components/RepoProfileCards.tsx`

Read `RepoProfileCards.tsx` first to reuse its exact chip/Tailwind idiom and `GitHubRepoChip`/`ClassificationBadge` imports.

- [ ] **Step 1: Create `DistillationCard.tsx`**

```tsx
import { useToggleRepoFeatured } from '../hooks/use-toggle-repo-featured.js'
import { cleanRepoTitle } from '../lib/distill.js'
import type { ConnectedRepo } from '../../../lib/types/github.types.js'

export function DistillationCard({ repo }: { readonly repo: ConnectedRepo }) {
  const { mutate, isPending } = useToggleRepoFeatured(repo.repoFullName)
  const featured = repo.isFeatured === true
  const highlights = repo.highlights ?? []
  const tech = [...new Set(repo.techStack ?? [])]

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-white/10 bg-white/2 p-4">
      <div className="flex items-start gap-2">
        <h4 className="text-sm font-semibold text-zinc-100">{cleanRepoTitle(repo.name)}</h4>
        <label className="ml-auto flex items-center gap-1.5 text-[11px] text-zinc-400">
          <input
            type="checkbox"
            checked={featured}
            disabled={isPending}
            onChange={e => mutate(e.target.checked)}
            className="accent-teal-500"
          />
          Use in resume
        </label>
      </div>

      {repo.oneLiner && (
        <p className="text-sm leading-relaxed text-zinc-400">{repo.oneLiner}</p>
      )}

      {highlights.length > 0 && (
        <ul className="list-disc space-y-1 pl-4 text-xs leading-relaxed text-zinc-300">
          {highlights.map((h, i) => (
            <li key={i}>{h}</li>
          ))}
        </ul>
      )}

      {tech.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {tech.map(t => (
            <span
              key={t}
              className="rounded border border-white/10 bg-white/5 px-1.5 py-0.5 text-[10px] text-zinc-400"
            >
              {t}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Refactor `RepoProfileCards.RepoCard`**

In `RepoProfileCards.tsx`, import `DistillationCard` and render it inside `RepoCard` as the resume section, **replacing** the one-liner + tech-stack blocks it currently renders (the `{repo.oneLiner && …}` paragraph and the tech-stack `flex flex-wrap` block), while **keeping** the header (`GitHubRepoChip` + `ClassificationBadge` + Re-index button), the quality/score section, and the sync-status footer. Net: `RepoCard` becomes header → `<DistillationCard repo={repo} />` → score section → footer. Do not change `RepoProfileCards`'s props, container, empty/loading states, or the connected-repos query usage.

- [ ] **Step 3: Typecheck + frontend test suite (no regression)**

Run: `cd "$WT" && yarn typecheck && cd "$WT" && yarn test`
Expected: typecheck PASS; full frontend vitest suite green (Task 3/4 tests included; no regressions). `DistillationCard`/`RepoProfileCards` are presentational — covered transitively by the hook/selector/helper tests per the spec's testing decision.

- [ ] **Step 4: Commit**

```bash
git -C "$WT" add src/features/github/components/DistillationCard.tsx src/features/user-home/components/RepoProfileCards.tsx
git -C "$WT" commit -m "feat(web): add shared DistillationCard and use it in RepoProfileCards"
```

---

## Task 6: Onboarding `distill` step

**Files:**
- Modify: `tucaken-app/src/features/onboarding/components/onboarding/types.ts` (`STEPS`, `StepId`)
- Modify: `tucaken-app/src/features/onboarding/components/onboarding/useOnboardingState.ts` (`STEP_INDEX`)
- Create: `tucaken-app/src/features/onboarding/components/steps/DistillStep.tsx`
- Modify: `tucaken-app/src/app/onboarding.tsx` (render the step; audit indices)
- Modify: `tucaken-app/src/features/onboarding/components/onboarding/OnboardingProgress.tsx`

Read all five files first. The step set is currently `welcome, portfolio, resume, connect, repos, processing, review`. Insert `distill` **between `processing` and `review`**.

- [ ] **Step 1: Add `distill` to `STEPS` + `StepId`**

In `types.ts`: add `'distill'` to the `StepId` union, and insert into the `STEPS` array between the `processing` and `review` entries:

```ts
  { id: 'distill',    name: 'Distill',       required: false },
```

- [ ] **Step 2: Add `distill` to `STEP_INDEX`**

In `useOnboardingState.ts` `STEP_INDEX`, set `distill: 6` and bump `review: 7` (keep every other entry; `ID_BY_INDEX` is derived from `STEPS` so it updates automatically — verify it does):

```ts
const STEP_INDEX: Record<StepId, number> = {
  welcome: 0, portfolio: 1, resume: 2, connect: 3,
  repos: 4, processing: 5, distill: 6, review: 7,
}
```

- [ ] **Step 3: Create `DistillStep.tsx`**

Read an existing step (e.g. `ProcessingStep.tsx`, `ConnectReposStep.tsx`) for the exact props/`StepFooter`/`StepHeader` idiom, then:

```tsx
import { useGitHubConnectedRepos } from '../../../github/hooks/use-github-connected-repos.js'
import { selectDistillableRepos } from '../../../github/lib/distill.js'
import { DistillationCard } from '../../../github/components/DistillationCard.js'
import { StepFooter } from '../onboarding/StepFooter.js'
import { StepHeader } from '../onboarding/StepHeader.js'

interface Props { readonly onNext: () => void; readonly onBack: () => void }

export function DistillStep({ onNext, onBack }: Props) {
  const { data } = useGitHubConnectedRepos()
  const cards = selectDistillableRepos(data ?? [])

  return (
    <div className="flex flex-1 flex-col">
      <StepHeader
        title="Your projects, resume-ready"
        subtitle="We distilled each project into resume-ready bullets. Toggle the ones to use."
      />
      {cards.length === 0 ? (
        <p className="py-10 text-center text-sm text-zinc-500">
          No resume-ready projects yet — connect more repos or re-index.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {cards.map(r => (
            <DistillationCard key={r.repoFullName} repo={r} />
          ))}
        </div>
      )}
      <div className="mt-auto">
        <StepFooter onBack={onBack} onNext={onNext} nextLabel="Continue" />
      </div>
    </div>
  )
}
```

> Match the real `StepHeader`/`StepFooter` prop names + import paths from a sibling step. If `StepFooter` requires `nextDisabled`, pass `false` (review is optional).

- [ ] **Step 4: Render it + audit indices in `onboarding.tsx`**

Read `onboarding.tsx`. It dispatches a component per `stepId` (mirror exactly how `ReviewStep`/`ProcessingStep` are rendered — same conditional/record). Add the `distill` case rendering `<DistillStep onNext={…} onBack={…} />` wired to the state machine's `next`/`back` exactly like adjacent steps. **Audit `CONNECT_STEP_INDEX = 3` (line 35) and any other hardcoded index / `STEP_INDEX.review` usage** — `connect` is still index 3 so `CONNECT_STEP_INDEX` is unchanged; confirm nothing else hardcodes `review`'s index (it moved 6→7). Update `OnboardingProgress.tsx` so the new step appears in the progress UI (it likely maps over `STEPS` — verify it renders `distill` and no count is hardcoded).

- [ ] **Step 5: Typecheck + full frontend suite**

Run: `cd "$WT" && yarn typecheck && cd "$WT" && yarn test`
Expected: typecheck PASS; full vitest suite green (incl. existing onboarding tests like `useOnboardingState.test.ts` — if that test asserts the step list/indices, update its expectations to include `distill` as part of THIS task and keep it green).

- [ ] **Step 6: Commit**

```bash
git -C "$WT" add src/features/onboarding/components/onboarding/types.ts src/features/onboarding/components/onboarding/useOnboardingState.ts src/features/onboarding/components/steps/DistillStep.tsx src/app/onboarding.tsx src/features/onboarding/components/onboarding/OnboardingProgress.tsx
git -C "$WT" commit -m "feat(web): add distillation step to onboarding flow"
```

> If `src/__tests__/features/onboarding/useOnboardingState.test.ts` needed updating, include it in this `git add`.

---

## Task 7: Full regression + finish

- [ ] **Step 1: admin-api regression**

Run: `cd "$WT/admin-api" && yarn test && cd "$WT/admin-api" && yarn typecheck`
Expected: full admin-api jest suite green (incl. new github GET/PATCH tests); typecheck clean.

- [ ] **Step 2: frontend regression**

Run: `cd "$WT" && yarn test && cd "$WT" && yarn typecheck`
Expected: full frontend vitest suite green (incl. distill helper + server-fn tests); typecheck clean.

- [ ] **Step 3: Lineage + clean tree**

Run: `git -C "$WT" log --oneline <base>..HEAD` (6 task commits) and `git -C "$WT" status --porcelain` (no tracked modifications). `<base>` = `git -C "$WT" merge-base HEAD origin/main`.

- [ ] **Step 4: Invoke superpowers:finishing-a-development-branch**

Use the finishing-a-development-branch skill to choose merge / PR / cleanup.

---

## Self-Review

**Spec coverage:**
- Bullets = all `highlights` verbatim, no LLM → Task 1 (expose) + Task 5 (`DistillationCard` renders 1–5, none if empty).
- Shared card in onboarding + refactored user-home → Task 5 (`DistillationCard`, `RepoProfileCards` refactor) + Task 6 (`DistillStep` reuses it).
- Toggle persists via `is_featured`/`feature_rank`, `MAX+1` enable / `NULL` disable → Task 2.
- Extend `GET /connected-repos` + new write route → Tasks 1, 2.
- Filter `project && !hidden && completed` (incl. exposing `is_hidden`) → Task 1 (expose `is_hidden`) + Task 4 (`selectDistillableRepos`) used in Tasks 5/6.
- Isolation via `requireUserId` + explicit `user_id` param (no `set_config`) → Task 2 mirrors `insertRepository`/`DELETE`.
- No migration / no Bedrock / no ai-applications change → no such tasks (correct).
- Testing: admin-api route tests (Task 1/2), server-fn vitest + pure selector/title tests (Tasks 3/4); presentational pieces covered transitively (spec decision) → Tasks 5/6 verified by typecheck + suite.

**Deliberate deviation (documented):** spec's `:owner/:repo` realized as the codebase's `:fullName` URL-encoded convention (server fn `encodeURIComponent`, route `decodeURIComponent`) — same behavior, matches `DELETE /connected-repos/:fullName`.

**Placeholder scan:** none — every step has concrete code/SQL/commands and expected results. "Adapt to harness/sibling" notes are precise (named the exact reference file + the invariant to preserve), not vague TODOs. `<base>` in Task 7 is a resolve-at-exec git command, not a code placeholder.

**Type consistency:** `ConnectedRepo` new fields (`highlights`/`isFeatured`/`featureRank`/`isHidden`) defined Task 3, produced by Task 1's map, consumed by Tasks 4/5. `setRepoFeaturedFn({ data:{ repoFullName, useInResume } })` signature consistent Tasks 3→3-hook→5 (`useToggleRepoFeatured(repoFullName).mutate(boolean)`). PATCH contract `{ useInResume:boolean }` → `{ repoFullName,isFeatured,featureRank }` consistent Task 2 (route) ↔ Task 3 (server fn/test). `selectDistillableRepos`/`cleanRepoTitle` names consistent Tasks 4→5→6. Step id `distill` + indices consistent Tasks 6 (`STEPS`/`STEP_INDEX`/`onboarding.tsx`/`OnboardingProgress`).
