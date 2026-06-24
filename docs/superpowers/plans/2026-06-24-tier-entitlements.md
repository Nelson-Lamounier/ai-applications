# Tier Entitlements & Stripe-Gated Plan Changes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce three subscription tiers (free/pro/premium) from a single entitlements module, gate Bedrock chunk enrichment on plan, and ensure a plan only ever changes on a confirmed Stripe payment.

**Architecture:** A central `entitlements.ts` module in tucaken-app admin-api is the single source of truth for per-tier limits (repos, projects, resumes/mo, ingestion jobs/mo) and enrichment mode. Every enforcement point reads it; an `isFullAccess(email)` predicate (driven by the existing email allowlists) short-circuits enforcement for the test user. A migration in ai-applications adds the `premium` plan value and teaches `effective_plan` about it. The Stripe webhook is hardened to grant a plan only when `payment_status === 'paid'`.

**Tech Stack:** TypeScript (Node 20, ESM), Hono (admin-api routes), `pg` (Postgres), Jest (unit), Vitest (integration), Stripe SDK, Kubernetes Job dispatch.

## Global Constraints

- Prose/comments/commits in **English (UK)**; **ASCII only** (no diacritics).
- **No "Co-Authored-By: Claude"** trailer in commits.
- Run **ESLint** before considering any change complete: `cd tucaken-app && yarn exec eslint admin-api/src --config admin-api/eslint.config.js --no-ignore`.
- Feature work on a dedicated branch; never commit feature work to a base branch. **ai-applications** branch `feat/tier-entitlements` off `develop` (this repo integrates on develop). **tucaken-app** branch `feat/tier-entitlements` off `origin/main` (this repo integrates on main — confirmed by recent PRs #155-159). Do not stage the unrelated untracked WIP present on the tucaken-app working tree.
- Migrations are numbered + checksum-ledgered; **never edit a historical migration**. Next number is **103**.
- Enforce limits at the **dispatch/route boundary**, never via display copy.
- Authenticated handlers derive `userId` from verified claims (`requireUserId`); never trust client-supplied plan/tier/enrichment.
- Unit-test pure helpers with Jest (`NODE_OPTIONS='--experimental-vm-modules' jest <file>`); route/DB behaviour via Vitest integration where a DB is required.
- **Deploy order:** migration 103 (ai-applications) must be live in an environment **before** the tucaken-app code that writes `plan='premium'` or relies on the premium `effective_plan` runs there.

**Tier model (keyed on effective plan):**

| effective plan | repos | projects | resumes/mo | ingestion jobs/mo | enrichment |
|----------------|-------|----------|-----------|-------------------|------------|
| free           | 1     | 1        | 1         | 3                 | tier1      |
| trial          | ∞     | ∞        | ∞         | ∞                 | tier1      |
| pro            | ∞     | ∞        | ∞         | ∞                 | tier1      |
| premium        | ∞     | ∞        | ∞         | ∞                 | full       |

`trial` mirrors `pro` (a trial is a paid-tier taste). Full-access override → premium-equivalent limits + `full` enrichment regardless of plan.

**Full-access is role-based (supersedes any `email`-based wording in task bodies below).** Per a security-review decision, `isFullAccess` is driven by the user's persisted `role === 'admin'` (already returned by `getUserPlanStatus`), NOT by the `AB_FREE_TIER_EMAILS` / `ENRICHMENT_TOGGLE_EMAILS` allowlists. Auditable, fail-closed, decoupled from the A/B lists. The test/owner account gets full access via its existing Cognito-admin-group → `role='admin'` provisioning. Everywhere a task says to thread `email` into `entitlementsFor` / `resolveEnrichmentEnv` / `getPlanLimit` for the override, thread the user's `role` (from `planStatus.role`) instead. `entitlements.ts` therefore imports NOTHING from `ab-free-tier`/`enrichment-toggle`.

---

## File Structure

**ai-applications**
- Create: `applications/platform-rds-bootstrap/migrations/103_premium_plan_tier.sql` — adds `premium` to the `users.plan` CHECK and the `premium` branch to `effective_plan` (where materialised). One responsibility: the premium-tier DB shape.

**tucaken-app/admin-api/src**
- Create: `lib/entitlements.ts` — tier→entitlements map + `isFullAccess` + `entitlementsFor` + `enrichmentEnv`. Single source of truth.
- Create: `lib/entitlements.test.ts` — unit tests for the module.
- Modify: `lib/repositories/users.ts` — extend `EffectivePlan` union; add premium branch to the `getUserPlanStatus` `effective_plan` CASE; add `countResumeGenerationsThisMonth` + `incrementResumeGenerationQuota` helpers.
- Modify: `lib/ingestion-job.ts` — rewrite `resolveEnrichmentEnv` to be plan-driven via `entitlements.ts`; thread `effectivePlan` through `IngestionJobOptions`.
- Modify: `lib/ingestion-job.test.ts` — update enrichment-env tests.
- Modify: `routes/github.ts` — `getPlanLimit` reads the map; add repo-count enforcement + full-access bypass; pass `effectivePlan` to dispatch.
- Modify: `routes/projects.ts` — project-count enforcement on `POST /`.
- Modify: `routes/applications.ts` (or the located resume-generation dispatch) — resume/mo quota enforcement.
- Modify: `src/server/stripe-webhook.ts` (tucaken-app SSR, not admin-api) — `payment_status==='paid'` gate.
- Create: `src/server/stripe-webhook.payment-gate.test.ts` — unit test for the gate guard.
- Modify: `src/features/billing/catalog.ts` — realign copy to enforced numbers.

---

## Task 1: Migration 103 — premium plan tier (ai-applications)

**Files:**
- Create: `applications/platform-rds-bootstrap/migrations/103_premium_plan_tier.sql`

**Interfaces:**
- Produces: `users.plan` accepts `'premium'`; any materialised `effective_plan` recognises premium. Consumed by Task 3 (query mirror) and all enforcement.

- [ ] **Step 1: Inspect how `effective_plan` exists today**

Run: `grep -rn "effective_plan\|plan IN (" applications/platform-rds-bootstrap/migrations/007_reverse_trial.sql`
Confirm whether `effective_plan` is a generated column/view or computed only in app SQL. (Per design it is computed in the app query; the migration then only needs the CHECK change plus, if a materialised `effective_plan` exists, its redefinition.)

- [ ] **Step 2: Write the migration**

```sql
-- 103_premium_plan_tier.sql
-- Add the 'premium' subscription tier.
--   1. Widen the users.plan CHECK constraint to allow 'premium'.
--   2. (If a materialised effective_plan exists) teach it the premium branch.
-- Idempotent: guarded so re-running is a no-op. Never edits a historical migration.

DO $$
BEGIN
  -- Drop the existing plan CHECK constraint whatever its generated name.
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'users'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%plan%'
      AND pg_get_constraintdef(oid) ILIKE '%free%'
      AND pg_get_constraintdef(oid) NOT ILIKE '%premium%'
  ) THEN
    EXECUTE (
      SELECT 'ALTER TABLE users DROP CONSTRAINT ' || quote_ident(conname)
      FROM pg_constraint
      WHERE conrelid = 'users'::regclass
        AND contype = 'c'
        AND pg_get_constraintdef(oid) ILIKE '%plan%'
        AND pg_get_constraintdef(oid) ILIKE '%free%'
      LIMIT 1
    );
  END IF;
END $$;

ALTER TABLE users
  ADD CONSTRAINT users_plan_check CHECK (plan IN ('free', 'pro', 'premium'));
```

> If Step 1 found a materialised `effective_plan` column/view, append its redefinition here with the premium branch:
> `WHEN plan = 'premium' AND subscription_status = 'active' THEN 'premium'` placed **before** the `pro` branch. If `effective_plan` is app-computed only (expected), no further SQL is needed — Task 3 mirrors it.

- [ ] **Step 3: Validate SQL syntax**

Run: `cd applications/platform-rds-bootstrap && (psql --version >/dev/null 2>&1 && echo psql-available || echo no-psql)`
If psql + a throwaway DB is available, apply against it and assert:
`INSERT INTO users (email, plan) VALUES ('t@t.dev','premium');` succeeds and `'bogus'` fails the CHECK.
Otherwise rely on the bootstrap runner's apply in a dev environment (the checksum ledger will record it).

- [ ] **Step 4: Commit**

```bash
git add applications/platform-rds-bootstrap/migrations/103_premium_plan_tier.sql
git commit -m "feat(rds): add premium plan tier to users.plan CHECK (migration 103)"
```

---

## Task 2: Entitlements module (tucaken-app)

**Files:**
- Create: `admin-api/src/lib/entitlements.ts`
- Create: `admin-api/src/lib/entitlements.test.ts`
- Modify: `admin-api/src/lib/repositories/users.ts:221` (extend `EffectivePlan`)

**Interfaces:**
- Consumes: nothing from `ab-free-tier`/`enrichment-toggle` (full-access is role-based — see Global Constraints).
- Produces:
  - `type EffectivePlan = 'free' | 'trial' | 'pro' | 'premium'` (extended in users.ts; re-exported via entitlements).
  - `type EnrichmentMode = 'tier1' | 'full'`
  - `interface Entitlements { repos: number; projects: number; resumesPerMonth: number; ingestionJobsPerMonth: number; enrichment: EnrichmentMode }`
  - `const ENTITLEMENTS: Record<EffectivePlan, Entitlements>`
  - `function isFullAccess(role: string | null | undefined): boolean` — returns `role === 'admin'`.
  - `function entitlementsFor(plan: EffectivePlan, role?: string | null): Entitlements` — `isFullAccess(role)` → `ENTITLEMENTS.premium`, else `ENTITLEMENTS[plan]`.
  - `function enrichmentEnv(mode: EnrichmentMode): Record<string, string>`

> **NOTE (role-based revision):** The code/tests printed below in Steps 1-4 show the original email-allowlist design and are SUPERSEDED. `isFullAccess(role)` returns `role === 'admin'`; `entitlementsFor(plan, role)` overrides to premium when admin. Tests assert `isFullAccess('admin') === true`, `isFullAccess('user'|null) === false`, and `entitlementsFor('free','admin')` deep-equals `ENTITLEMENTS.premium`. No env vars, no allowlist imports.

- [ ] **Step 1: Extend the `EffectivePlan` union**

In `admin-api/src/lib/repositories/users.ts`, change line 221 from:
```ts
export type EffectivePlan = 'pro' | 'trial' | 'free';
```
to:
```ts
export type EffectivePlan = 'free' | 'trial' | 'pro' | 'premium';
```

- [ ] **Step 2: Write the failing test**

Create `admin-api/src/lib/entitlements.test.ts`:
```ts
/** @format */
import { ENTITLEMENTS, isFullAccess, entitlementsFor, enrichmentEnv } from './entitlements.js';

describe('ENTITLEMENTS', () => {
    it('free is the only metered tier; pro/premium are unlimited', () => {
        expect(ENTITLEMENTS.free).toEqual({
            repos: 1, projects: 1, resumesPerMonth: 1, ingestionJobsPerMonth: 3, enrichment: 'tier1',
        });
        expect(ENTITLEMENTS.pro.repos).toBe(Infinity);
        expect(ENTITLEMENTS.premium.repos).toBe(Infinity);
    });
    it('only premium gets full chunk enrichment; trial mirrors pro', () => {
        expect(ENTITLEMENTS.free.enrichment).toBe('tier1');
        expect(ENTITLEMENTS.pro.enrichment).toBe('tier1');
        expect(ENTITLEMENTS.premium.enrichment).toBe('full');
        expect(ENTITLEMENTS.trial).toEqual(ENTITLEMENTS.pro);
    });
});

describe('isFullAccess', () => {
    const A = process.env.AB_FREE_TIER_EMAILS, E = process.env.ENRICHMENT_TOGGLE_EMAILS;
    afterEach(() => { process.env.AB_FREE_TIER_EMAILS = A; process.env.ENRICHMENT_TOGGLE_EMAILS = E; });

    it('is true when the email is on either existing allowlist (case-insensitive)', () => {
        process.env.AB_FREE_TIER_EMAILS = 'lamounier_88@hotmail.com';
        process.env.ENRICHMENT_TOGGLE_EMAILS = '';
        expect(isFullAccess('LAMOUNIER_88@hotmail.com')).toBe(true);
    });
    it('is false for a normal user and for null', () => {
        process.env.AB_FREE_TIER_EMAILS = 'lamounier_88@hotmail.com';
        process.env.ENRICHMENT_TOGGLE_EMAILS = 'lamounier_88@hotmail.com';
        expect(isFullAccess('someone@else.com')).toBe(false);
        expect(isFullAccess(null)).toBe(false);
    });
});

describe('entitlementsFor', () => {
    const A = process.env.AB_FREE_TIER_EMAILS, E = process.env.ENRICHMENT_TOGGLE_EMAILS;
    beforeEach(() => { process.env.AB_FREE_TIER_EMAILS = 'lamounier_88@hotmail.com'; process.env.ENRICHMENT_TOGGLE_EMAILS = ''; });
    afterEach(() => { process.env.AB_FREE_TIER_EMAILS = A; process.env.ENRICHMENT_TOGGLE_EMAILS = E; });

    it('returns the plan map for a normal user', () => {
        expect(entitlementsFor('free', 'someone@else.com')).toEqual(ENTITLEMENTS.free);
    });
    it('grants premium-equivalent + full enrichment to a full-access email regardless of plan', () => {
        expect(entitlementsFor('free', 'lamounier_88@hotmail.com')).toEqual(ENTITLEMENTS.premium);
    });
});

describe('enrichmentEnv', () => {
    it('tier1 disables the enricher but keeps deterministic Tier 1', () => {
        expect(enrichmentEnv('tier1')).toEqual({ ENRICHMENT_DISABLED: '1', ENRICH_TIER1: '1' });
    });
    it('full lets the enricher run (Tier 1 still flagged)', () => {
        expect(enrichmentEnv('full')).toEqual({ ENRICH_TIER1: '1' });
    });
});
```

- [ ] **Step 3: Run the test, expect failure**

Run: `cd admin-api && NODE_OPTIONS='--experimental-vm-modules' jest src/lib/entitlements.test.ts`
Expected: FAIL — `Cannot find module './entitlements.js'`.

- [ ] **Step 4: Implement the module**

Create `admin-api/src/lib/entitlements.ts`:
```ts
/**
 * @format
 * Central tier-entitlements map — the single source of truth for per-plan
 * limits and enrichment mode. Every enforcement point (repo/project/resume/
 * ingestion quotas) and the ingestion dispatch read from here so the tier
 * definition lives in exactly one place.
 *
 * Keyed on EFFECTIVE plan (trial/active resolution), not the raw column.
 * `trial` mirrors `pro` — a trial is a paid-tier taste.
 *
 * The full-access override (`isFullAccess`) reuses the existing email
 * allowlists (AB_FREE_TIER_EMAILS / ENRICHMENT_TOGGLE_EMAILS) so the test
 * user keeps unlimited access without a hardcoded address.
 */
import { isFreeTierAllowed } from './ab-free-tier.js';
import { isEnrichmentToggleAllowed } from './enrichment-toggle.js';
import type { EffectivePlan } from './repositories/users.js';

export type { EffectivePlan };
export type EnrichmentMode = 'tier1' | 'full';

export interface Entitlements {
    /** Max connected repositories. Infinity = unlimited. */
    repos: number;
    /** Max projects. Infinity = unlimited. */
    projects: number;
    /** Max JD resume generations per calendar month. Infinity = unlimited. */
    resumesPerMonth: number;
    /** Max ingestion (sync/build) jobs per calendar month. Infinity = unlimited. */
    ingestionJobsPerMonth: number;
    /** Chunk-enrichment depth during sync/build. */
    enrichment: EnrichmentMode;
}

const UNLIMITED: Entitlements = {
    repos: Infinity,
    projects: Infinity,
    resumesPerMonth: Infinity,
    ingestionJobsPerMonth: Infinity,
    enrichment: 'tier1',
};

export const ENTITLEMENTS: Record<EffectivePlan, Entitlements> = {
    free:    { repos: 1, projects: 1, resumesPerMonth: 1, ingestionJobsPerMonth: 3, enrichment: 'tier1' },
    trial:   { ...UNLIMITED },
    pro:     { ...UNLIMITED },
    premium: { ...UNLIMITED, enrichment: 'full' },
};

/**
 * Full-access override for the test/owner account. Driven by the existing
 * allowlists so it is env-configurable and not hardcoded.
 */
export function isFullAccess(email: string | null | undefined): boolean {
    return isFreeTierAllowed(email) || isEnrichmentToggleAllowed(email ?? undefined);
}

/** Effective entitlements: full-access override first, else the plan map. */
export function entitlementsFor(plan: EffectivePlan, email?: string | null): Entitlements {
    if (isFullAccess(email)) return ENTITLEMENTS.premium;
    return ENTITLEMENTS[plan];
}

/** Worker env vars for an enrichment mode (consumed by the ingestion Job). */
export function enrichmentEnv(mode: EnrichmentMode): Record<string, string> {
    return mode === 'full'
        ? { ENRICH_TIER1: '1' }
        : { ENRICHMENT_DISABLED: '1', ENRICH_TIER1: '1' };
}
```

- [ ] **Step 5: Run the test, expect pass; lint**

Run: `cd admin-api && NODE_OPTIONS='--experimental-vm-modules' jest src/lib/entitlements.test.ts`
Expected: PASS (all suites).
Run: `cd .. && yarn exec eslint admin-api/src/lib/entitlements.ts admin-api/src/lib/entitlements.test.ts --config admin-api/eslint.config.js --no-ignore`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add admin-api/src/lib/entitlements.ts admin-api/src/lib/entitlements.test.ts admin-api/src/lib/repositories/users.ts
git commit -m "feat(billing): add central tier-entitlements module + premium effective plan"
```

---

## Task 3: Teach `getUserPlanStatus` about premium (tucaken-app)

**Files:**
- Modify: `admin-api/src/lib/repositories/users.ts:273-277` (the `effective_plan` CASE)

**Interfaces:**
- Consumes: extended `EffectivePlan` from Task 2.
- Produces: `getUserPlanStatus(...).effectivePlan` can return `'premium'`. Consumed by Tasks 4-8.

- [ ] **Step 1: Update the `effective_plan` CASE to mirror migration 103**

In `getUserPlanStatus` replace the CASE (lines ~273-277):
```sql
       CASE
         WHEN plan = 'premium' AND subscription_status = 'active' THEN 'premium'
         WHEN plan = 'pro'     AND subscription_status = 'active' THEN 'pro'
         WHEN plan = 'free'    AND trial_ends_at > NOW()          THEN 'trial'
         ELSE 'free'
       END AS effective_plan,
```

- [ ] **Step 2: Typecheck**

Run: `cd admin-api && yarn typecheck`
Expected: passes (the cast `row.effective_plan as EffectivePlan` now includes premium).

- [ ] **Step 3: Integration check (if a test DB is configured)**

Run: `cd admin-api && vitest run --config vitest.integration.config.ts -t "plan status"`
If no integration DB is wired for this path, assert manually against a dev DB:
a user with `plan='premium', subscription_status='active'` returns `effectivePlan='premium'`.
Document the manual check in the commit body if integration is skipped.

- [ ] **Step 4: Commit**

```bash
git add admin-api/src/lib/repositories/users.ts
git commit -m "feat(billing): resolve premium in getUserPlanStatus effective_plan"
```

---

## Task 4: Plan-driven enrichment gating (tucaken-app)

**Files:**
- Modify: `admin-api/src/lib/ingestion-job.ts:7,26-34,48-76` and the `buildIngestionJobSpec` enrichment-env call site (~line 224)
- Modify: `admin-api/src/lib/ingestion-job.test.ts`
- Modify: `admin-api/src/routes/github.ts` dispatch sites (~1024-1038, ~398-412, ~1585) to pass `effectivePlan`

**Interfaces:**
- Consumes: `entitlementsFor`, `enrichmentEnv`, `EffectivePlan` from Task 2; `getUserPlanStatus` from Task 3.
- Produces: `resolveEnrichmentEnv(plan: EffectivePlan, email: string | undefined): Record<string,string>`; `IngestionJobOptions.effectivePlan?: EffectivePlan`.

- [ ] **Step 1: Update the enrichment-env unit tests**

In `admin-api/src/lib/ingestion-job.test.ts`, replace the `resolveEnrichmentEnv` describe block with:
```ts
import { resolveEnrichmentEnv } from './ingestion-job.js';

describe('resolveEnrichmentEnv (plan-driven)', () => {
    const A = process.env.AB_FREE_TIER_EMAILS, E = process.env.ENRICHMENT_TOGGLE_EMAILS;
    beforeEach(() => { process.env.AB_FREE_TIER_EMAILS = ''; process.env.ENRICHMENT_TOGGLE_EMAILS = ''; });
    afterEach(() => { process.env.AB_FREE_TIER_EMAILS = A; process.env.ENRICHMENT_TOGGLE_EMAILS = E; });

    it('free/pro/trial get Tier-1 only (no Bedrock enricher)', () => {
        for (const plan of ['free', 'pro', 'trial'] as const) {
            expect(resolveEnrichmentEnv(plan, 'u@x.com')).toEqual({ ENRICHMENT_DISABLED: '1', ENRICH_TIER1: '1' });
        }
    });
    it('premium gets full enrichment', () => {
        expect(resolveEnrichmentEnv('premium', 'u@x.com')).toEqual({ ENRICH_TIER1: '1' });
    });
    it('full-access email gets full enrichment on any plan', () => {
        process.env.ENRICHMENT_TOGGLE_EMAILS = 'lamounier_88@hotmail.com';
        expect(resolveEnrichmentEnv('free', 'lamounier_88@hotmail.com')).toEqual({ ENRICH_TIER1: '1' });
    });
});
```

- [ ] **Step 2: Run the test, expect failure**

Run: `cd admin-api && NODE_OPTIONS='--experimental-vm-modules' jest src/lib/ingestion-job.test.ts -t "plan-driven"`
Expected: FAIL — signature mismatch / old behaviour.

- [ ] **Step 3: Rewrite `resolveEnrichmentEnv`**

In `admin-api/src/lib/ingestion-job.ts`, replace lines 7 and 26-34:
```ts
import { entitlementsFor, enrichmentEnv } from './entitlements.js';
import type { EffectivePlan } from './repositories/users.js';
```
```ts
/**
 * Map the user's EFFECTIVE plan to the concrete enrichment Job env vars.
 * Premium (or a full-access email) → full per-chunk enrichment; everyone else
 * → Tier-1 deterministic only. Fails closed to Tier-1, never to premium.
 */
export function resolveEnrichmentEnv(
    plan: EffectivePlan,
    email: string | undefined,
): Record<string, string> {
    return enrichmentEnv(entitlementsFor(plan, email).enrichment);
}
```

- [ ] **Step 4: Thread `effectivePlan` through `IngestionJobOptions`**

In the `IngestionJobOptions` interface (~48-76), remove the client-controlled `enrichment` field and its doc (lines ~69-75) and add:
```ts
    /**
     * The user's effective plan, resolved server-side via getUserPlanStatus.
     * Drives enrichment depth. Never client-supplied.
     */
    readonly effectivePlan?: EffectivePlan;
```
At the `buildIngestionJobSpec` enrichment-env call site (~line 224), replace:
```ts
        ...resolveEnrichmentEnv(opts.email, opts.enrichment),
```
with:
```ts
        ...resolveEnrichmentEnv(opts.effectivePlan ?? 'free', opts.email),
```

- [ ] **Step 5: Update dispatch sites to pass `effectivePlan`**

In `admin-api/src/routes/github.ts`, the dispatch sites currently pass `email`/`enrichment`. At each (`dispatchIngestionJob` builder ~1024-1038, the install auto-sync ~398-412, the push webhook ~1585), resolve the effective plan once via `getUserPlanStatus` and pass it. Replace the `enrichment` argument plumbing with:
```ts
        const planStatus = await getUserPlanStatus(pool, userId); // or user.userId
        const effectivePlan = planStatus?.effectivePlan ?? 'free';
        // ...in the buildIngestionJobSpec opts:
        ...(effectivePlan !== undefined ? { effectivePlan } : {}),
```
Remove any `enrichment` value read from the client request body (the client no longer chooses enrichment). Keep `email` plumbing (still passed for `resolveEnrichmentEnv`).

- [ ] **Step 6: Run tests + typecheck + lint**

Run: `cd admin-api && NODE_OPTIONS='--experimental-vm-modules' jest src/lib/ingestion-job.test.ts && yarn typecheck`
Expected: PASS.
Run: `cd .. && yarn exec eslint admin-api/src/lib/ingestion-job.ts admin-api/src/routes/github.ts --config admin-api/eslint.config.js --no-ignore`
Expected: no errors (remove now-unused `isEnrichmentToggleAllowed` import from ingestion-job.ts if it is no longer referenced).

- [ ] **Step 7: Commit**

```bash
git add admin-api/src/lib/ingestion-job.ts admin-api/src/lib/ingestion-job.test.ts admin-api/src/routes/github.ts
git commit -m "feat(ingestion): gate chunk enrichment on effective plan, not email allowlist"
```

---

## Task 5: Ingestion-jobs quota from the map (tucaken-app)

**Files:**
- Modify: `admin-api/src/routes/github.ts:296-298` (`getPlanLimit`) and its 3 call sites (~398, ~1144, ~1651)

**Interfaces:**
- Consumes: `ENTITLEMENTS`, `entitlementsFor`, `isFullAccess` from Task 2; `EffectivePlan`.
- Produces: `getPlanLimit(plan: EffectivePlan, email?: string | null): number`.

- [ ] **Step 1: Replace `getPlanLimit` to read the map**

In `admin-api/src/routes/github.ts`, add at top: `import { entitlementsFor } from '../lib/entitlements.js';` and replace lines 296-298:
```ts
function getPlanLimit(plan: string, email?: string | null): number {
    return entitlementsFor((plan as import('../lib/entitlements.js').EffectivePlan), email).ingestionJobsPerMonth;
}
```
Delete the now-unused `FREE_PLAN_LIMIT` constant (line 67) — the map owns the number.

- [ ] **Step 2: Pass effective plan + email at the 3 call sites**

At each `getPlanLimit(plan)` call (~398, ~1144, ~1651), pass the effective plan resolved in Task 4 and the caller email:
```ts
        const limit   = getPlanLimit(effectivePlan, callerEmail);
```
(Where `callerEmail` is the already-available `ctx.get('jwtPayload')?.['email']`; for the push-webhook site, the email may be absent — pass `undefined`, which simply means no full-access override there.)

- [ ] **Step 3: Typecheck + lint**

Run: `cd admin-api && yarn typecheck && cd .. && yarn exec eslint admin-api/src/routes/github.ts --config admin-api/eslint.config.js --no-ignore`
Expected: no errors. `FREE_PLAN_LIMIT` no longer referenced.

- [ ] **Step 4: Commit**

```bash
git add admin-api/src/routes/github.ts
git commit -m "feat(billing): source ingestion-job monthly cap from entitlements map"
```

---

## Task 6: Repository-count limit (tucaken-app)

**Files:**
- Modify: `admin-api/src/routes/github.ts` — `connected-repos` POST (~1139) and the install auto-sync (~398)

**Interfaces:**
- Consumes: `entitlementsFor` from Task 2.
- Produces: `countConnectedRepos(pool, userId)` helper; a `403`/`429` when `repos` cap reached.

- [ ] **Step 1: Add a repo-count helper**

In `admin-api/src/routes/github.ts` (near the other DB helpers, after `getConnection`):
```ts
async function countConnectedRepos(pool: Pool, userId: string): Promise<number> {
    const { rows } = await pool.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n
         FROM repositories
         WHERE user_id = $1::uuid AND provider = 'github'`,
        [userId],
    );
    return Number(rows[0]?.n ?? '0');
}
```

- [ ] **Step 2: Enforce before connecting a new repo**

In the `connected-repos` POST handler, after resolving `effectivePlan`/`callerEmail` and BEFORE `connectRepoWithDefaultProject`, add. First locate how the handler already detects an existing connection for the requested repo (run `grep -n "repositories\|full_name\|already\|EXISTS" admin-api/src/routes/github.ts` within the handler) and capture it as `repoAlreadyConnected: boolean`:
```ts
        // repoAlreadyConnected: true when the requested repo is already in
        // `repositories` for this user (reuse the handler's existing lookup;
        // do NOT re-query). Re-syncing an existing repo must stay allowed.
        const repoCap = entitlementsFor(effectivePlan, callerEmail).repos;
        if (Number.isFinite(repoCap) && !repoAlreadyConnected) {
            const already = await countConnectedRepos(pool, uid);
            if (already >= repoCap) {
                return ctx.json({
                    error: `Your plan allows ${repoCap} repository${repoCap === 1 ? '' : 's'}. Upgrade for more.`,
                    upgradeUrl: '/pricing',
                }, 403);
            }
        }
```
Intent: a free user with their 1 repo can still re-sync it, but cannot add a 2nd.

- [ ] **Step 3: Mirror the guard in install auto-sync**

In `autoDispatchRepos` (~398), when iterating repos to auto-dispatch on install, stop dispatching once `countConnectedRepos` would exceed `repoCap` for the user (free users auto-connecting many repos on install must be capped to `repos`). Dispatch only the first `repoCap` repos; log the skipped count:
```ts
        const repoCap = entitlementsFor(effectivePlan, undefined).repos;
        // ...when selecting repos to dispatch:
        const capped = Number.isFinite(repoCap) ? repos.slice(0, repoCap) : repos;
        if (capped.length < repos.length) {
            console.log(`[github] plan cap: dispatching ${capped.length}/${repos.length} repos for ${userId}`);
        }
```

- [ ] **Step 4: Typecheck + lint + commit**

Run: `cd admin-api && yarn typecheck && cd .. && yarn exec eslint admin-api/src/routes/github.ts --config admin-api/eslint.config.js --no-ignore`
```bash
git add admin-api/src/routes/github.ts
git commit -m "feat(billing): enforce per-plan repository-count limit (free=1)"
```

---

## Task 7: Project-count limit (tucaken-app)

**Files:**
- Modify: `admin-api/src/routes/projects.ts:172` (`POST /`)

**Interfaces:**
- Consumes: `entitlementsFor`; `getUserPlanStatus`.
- Produces: `countUserProjects(db, userId)`; a `403` when the `projects` cap is reached.

- [ ] **Step 1: Add a project-count helper**

In `admin-api/src/lib/repositories/projects.ts`, export:
```ts
export async function countUserProjects(db: Queryable, userId: string): Promise<number> {
    const { rows } = await db.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM projects WHERE user_id = $1::uuid`,
        [userId],
    );
    return Number(rows[0]?.n ?? '0');
}
```
(Confirm the `projects` table + `user_id` column names via `grep -n "FROM projects\|INTO projects" src/lib/repositories/projects.ts`; adjust if the column differs.)

- [ ] **Step 2: Enforce in `POST /` before `createProject`**

In `routes/projects.ts` `POST /`, after the field validation and before the `withUser(... createProject ...)` call:
```ts
        const planStatus = await getUserPlanStatus(pool, uid);
        const email = ctx.get('jwtPayload')?.['email'] as string | undefined;
        const projectCap = entitlementsFor(planStatus?.effectivePlan ?? 'free', email).projects;
        if (Number.isFinite(projectCap)) {
            const existing = await withUser(pool, uid, (db) => countUserProjects(db, uid));
            if (existing >= projectCap) {
                return ctx.json({
                    error: `Your plan allows ${projectCap} project${projectCap === 1 ? '' : 's'}. Upgrade for more.`,
                    upgradeUrl: '/pricing',
                }, 403);
            }
        }
```
Add imports: `import { entitlementsFor } from '../lib/entitlements.js';`, `import { getUserPlanStatus } from '../lib/repositories/users.js';`, and `countUserProjects` from the projects repo.

> Note: the github auto-created `single_repo` default project (via `ensureDefaultProject`) is exempt from this user-facing cap — it is created by the repo-connect path, which is already capped by Task 6. Only the user-facing `POST /projects` is gated here.

- [ ] **Step 3: Typecheck + lint + commit**

Run: `cd admin-api && yarn typecheck && cd .. && yarn exec eslint admin-api/src/routes/projects.ts admin-api/src/lib/repositories/projects.ts --config admin-api/eslint.config.js --no-ignore`
```bash
git add admin-api/src/routes/projects.ts admin-api/src/lib/repositories/projects.ts
git commit -m "feat(billing): enforce per-plan project-count limit (free=1)"
```

---

## Task 8: Resume-generation monthly quota (tucaken-app)

**Files:**
- Modify: the JD resume-generation dispatch route (locate in Step 1) + `admin-api/src/lib/repositories/users.ts` (quota helpers)

**Interfaces:**
- Consumes: `entitlementsFor`; `getUserPlanStatus`.
- Produces: `checkAndIncrementResumeQuota(pool, userId, limit)` mirroring the ingestion quota.

- [ ] **Step 1: Locate the JD resume-generation trigger**

Run across both repos:
```bash
grep -rn "resume" tucaken-app/admin-api/src/routes/*.ts | grep -i "generat\|tailor\|dispatch\|post\("
grep -rn "tailoredResumeData\|resumeBullets\|resume-import-processor\|MODE" tucaken-app/admin-api/src/routes tucaken-app/src/server
```
The "resume import" path (`routes/resume-imports.ts`, already caps 1/month via `countImportsThisMonth`) is distinct from JD **generation**. If JD-generation is dispatched from a route here, that is the enforcement point; if it is only triggered inside the strategist pipeline (ai-applications) with no admin-api route, enforce at the admin-api route that *starts* a generation (the one the frontend calls). Record the located file:line in the commit body.

- [ ] **Step 2: Add the quota helpers (mirror the ingestion pattern)**

In `admin-api/src/lib/repositories/users.ts`:
```ts
/** Atomic check-and-increment of the monthly resume-generation counter. */
export async function checkAndIncrementResumeQuota(
    pool: Pick<import('pg').Pool, 'query'>,
    userId: string,
    limit: number,
): Promise<boolean> {
    if (!Number.isFinite(limit)) return true;
    const { rows } = await pool.query<{ count: number }>(
        `INSERT INTO usage_quotas (user_id, feature, period_month, count)
         VALUES ($1::uuid, 'resume_generations', DATE_TRUNC('month', NOW()), 1)
         ON CONFLICT (user_id, feature, period_month)
         DO UPDATE SET count = usage_quotas.count + 1, updated_at = NOW()
         WHERE usage_quotas.count < $2
         RETURNING count`,
        [userId, limit],
    );
    return rows.length > 0;
}
```

- [ ] **Step 3: Enforce at the located dispatch**

Before starting the generation:
```ts
        const planStatus = await getUserPlanStatus(pool, userId);
        const email = ctx.get('jwtPayload')?.['email'] as string | undefined;
        const cap = entitlementsFor(planStatus?.effectivePlan ?? 'free', email).resumesPerMonth;
        const allowed = await checkAndIncrementResumeQuota(pool, userId, cap);
        if (!allowed) {
            ctx.header('Retry-After', String(secondsUntilNextMonthUTC()));
            return ctx.json({
                error: 'Free tier allows 1 resume generation per month. Upgrade for unlimited.',
                upgradeUrl: '/pricing',
            }, 429);
        }
```
If the generation dispatch can fail after this increment, decrement on failure (mirror `decrementQuota`, with `feature='resume_generations'`).

- [ ] **Step 4: Typecheck + lint + commit**

Run: `cd admin-api && yarn typecheck && cd .. && yarn exec eslint admin-api/src --config admin-api/eslint.config.js --no-ignore`
```bash
git add admin-api/src/lib/repositories/users.ts <located-route-file>
git commit -m "feat(billing): enforce per-plan monthly resume-generation quota (free=1)"
```

---

## Task 9: Stripe payment hardening (tucaken-app SSR)

**Files:**
- Modify: `src/server/stripe-webhook.ts:108-150` (`onCheckoutCompleted`)
- Create: `src/server/stripe-webhook.payment-gate.test.ts`
- Verify: `src/server/stripe.ts` (`tierForPriceId` maps premium price IDs)

**Interfaces:**
- Produces: `shouldGrantFromCheckout(session): boolean` — extracted pure guard, unit-tested.

- [ ] **Step 1: Write the failing test for the guard**

Create `src/server/stripe-webhook.payment-gate.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { shouldGrantFromCheckout } from './stripe-webhook';

const base = { payment_status: 'paid', status: 'complete' } as const;

describe('shouldGrantFromCheckout', () => {
    it('grants only when payment_status is paid and session complete', () => {
        expect(shouldGrantFromCheckout({ ...base })).toBe(true);
    });
    it('refuses when payment is unpaid or no_payment_required', () => {
        expect(shouldGrantFromCheckout({ ...base, payment_status: 'unpaid' })).toBe(false);
        expect(shouldGrantFromCheckout({ ...base, payment_status: 'no_payment_required' })).toBe(false);
    });
    it('refuses when the session is not complete', () => {
        expect(shouldGrantFromCheckout({ ...base, status: 'open' })).toBe(false);
    });
});
```

- [ ] **Step 2: Run it, expect failure**

Run: `cd tucaken-app && vitest run src/server/stripe-webhook.payment-gate.test.ts`
Expected: FAIL — `shouldGrantFromCheckout` not exported.

- [ ] **Step 3: Add the guard and apply it**

In `src/server/stripe-webhook.ts`, add and export:
```ts
/**
 * A checkout may complete WITHOUT a successful payment (unpaid, $0 trial via
 * no_payment_required, or an incomplete session). Only grant a paid plan when
 * Stripe confirms the money landed; otherwise the later
 * customer.subscription.updated / invoice.paid events sync the user once
 * payment truly succeeds.
 */
export function shouldGrantFromCheckout(
    session: Pick<Stripe.Checkout.Session, 'payment_status' | 'status'>,
): boolean {
    return session.payment_status === 'paid' && session.status === 'complete';
}
```
In `onCheckoutCompleted`, immediately after the `if (!customerId || !subscriptionId || !tier)` guard, add:
```ts
  if (!shouldGrantFromCheckout(session)) {
    logger.warn(
      { event: 'stripe_checkout_unpaid', sessionId: session.id, paymentStatus: session.payment_status, status: session.status },
      'checkout.session.completed without confirmed payment — not granting plan; awaiting invoice.paid',
    );
    return;
  }
```

- [ ] **Step 4: Verify premium price mapping**

Run: `grep -n "premium\|tierForPriceId\|STRIPE_PRICE_PREMIUM" src/server/stripe.ts`
Confirm `tierForPriceId` returns `'premium'` for the premium price IDs. If it only knows pro, add the premium branch (using `STRIPE_PRICE_PREMIUM_MONTHLY` / `STRIPE_PRICE_PREMIUM_ANNUAL`). Add a unit assertion if a test for `tierForPriceId` exists.

- [ ] **Step 5: Run test, expect pass; lint; commit**

Run: `cd tucaken-app && vitest run src/server/stripe-webhook.payment-gate.test.ts`
Expected: PASS.
Run: `yarn exec eslint src/server/stripe-webhook.ts src/server/stripe.ts --no-ignore` (use the SSR eslint config).
```bash
git add src/server/stripe-webhook.ts src/server/stripe-webhook.payment-gate.test.ts src/server/stripe.ts
git commit -m "fix(billing): grant a plan only on confirmed Stripe payment (payment_status=paid)"
```

---

## Task 10: Tier-change lockdown — make it provable (tucaken-app)

**Files:**
- Create: `admin-api/src/routes/tier-lockdown.integration.test.ts` (Vitest integration)
- Inspect: the bootstrap grants for the `tucaken_app` role (ai-applications migration 003)

**Interfaces:**
- Consumes: existing user-JWT routes; the M2M-only `PATCH /api/internal/billing/subscription`.
- Produces: a regression test proving no user-JWT path mutates `plan`.

- [ ] **Step 1: Confirm the role grant**

Run: `grep -rn "tucaken_app\|GRANT\|UPDATE" applications/platform-rds-bootstrap/migrations/003_cognito_user_provisioning.sql | grep -i "users\|plan\|grant"` (in ai-applications).
Confirm `tucaken_app` has **no UPDATE on `users`** (or only on non-plan columns). If a broad `GRANT UPDATE ON users` exists, add a migration **104** restricting it (column-level grants excluding `plan`, `subscription_status`, `stripe_*`). Only add 104 if the grant is actually too broad; otherwise record "verified: tucaken_app cannot UPDATE users.plan" in the commit body.

- [ ] **Step 2: Write the regression test**

Create `admin-api/src/routes/tier-lockdown.integration.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
// Boots the admin-api app against a test DB the same way other integration
// tests in this repo do (reuse the existing harness; see *.integration tests).

describe('tier-change lockdown', () => {
    it('no user-JWT route exposes a plan/subscription write', async () => {
        // Assert there is no route that accepts user-JWT auth and updates
        // users.plan / subscription_status / stripe_*. The only writer is the
        // M2M PATCH /api/internal/billing/subscription (m2mAuth-gated).
        // Drive a user-authenticated request at /api/admin/me and any profile
        // mutation route with a forged { plan: 'premium' } body and assert the
        // stored plan is unchanged.
        const before = 'free';
        // ...issue authenticated PATCH/POSTs with plan in the body...
        const after = before; // replace with a real DB read of users.plan
        expect(after).toBe('free');
    });
});
```
Flesh out using the repo's existing integration harness (find it: `grep -rln "vitest.integration\|createApp\|supertest\|app.request" admin-api/src`). The test must: provision a user, attempt every user-facing mutation route with `plan`/`subscription_status` in the body, then read `users.plan` directly and assert it is still `'free'`.

- [ ] **Step 3: Run it, expect pass**

Run: `cd admin-api && vitest run --config vitest.integration.config.ts tier-lockdown`
Expected: PASS (the writes are ignored / rejected; plan stays free).

- [ ] **Step 4: Commit**

```bash
git add admin-api/src/routes/tier-lockdown.integration.test.ts
git commit -m "test(billing): prove no user-JWT path can change a subscription tier"
```

---

## Task 11: Catalog copy realign + onboarding-id confirmation (tucaken-app)

**Files:**
- Modify: `src/features/billing/catalog.ts:36-99`
- Verify: `admin-api/src/routes/me.ts` returns `id` on the `isNew` path

**Interfaces:** none new — copy + a confirmation test.

- [ ] **Step 1: Realign catalog numbers to enforced limits**

In `src/features/billing/catalog.ts`, update the `free` tier features so the copy matches code: `'1 repository'`, `'1 project'`, `'1 resume per month'`. Update `pro`/`premium` to "Unlimited repositories", "Unlimited resumes"; mark **premium** with "Deep chunk-enrichment on sync" (the real differentiator). Remove unenforced/unimplemented claims (e.g. SSO, audit log) or move them under a clearly-labelled "coming soon" so copy never overstates the product.

- [ ] **Step 2: Confirm `/me` returns the generated UUID at onboarding**

Run: `grep -n "id:\s*userId\|isNew" admin-api/src/routes/me.ts`
Confirm `GET /api/admin/me` already returns `{ id: userId, isNew }` (it does — me.ts:50,56). Add a one-line code comment at me.ts:50 documenting that this is the onboarding-time return of the generated `users.id`. No behaviour change needed — the requirement ("record the generated user ID, returned to client") is satisfied by this response.

- [ ] **Step 3: Lint + commit**

Run: `cd tucaken-app && yarn exec eslint src/features/billing/catalog.ts --no-ignore`
```bash
git add src/features/billing/catalog.ts admin-api/src/routes/me.ts
git commit -m "docs(billing): align tier catalog copy with enforced limits; note onboarding id return"
```

---

## Wrap-up

- [ ] **Open two PRs off `develop`** — one per repo — cross-linking each other. ai-applications PR (migration 103) must merge + deploy first.
- [ ] **Full lint + typecheck both repos** before requesting review.
- [ ] **Manual smoke** on dev: a fresh free user can connect exactly 1 repo / 1 project / 1 resume/mo and their sync runs Tier-1 only; the full-access email is unlimited + full enrichment; a premium plan (set only via a real Stripe `payment_status=paid` checkout) unlocks full enrichment.

## Self-review notes (coverage vs spec)

- Spec §1 entitlements module → Task 2. §2 migration → Task 1; effective_plan mirror → Task 3. §3 enforcement (repos/projects/resumes/ingestion) → Tasks 5-8. §4 enrichment gating → Task 4. §5 payment hardening → Task 9. §6 lockdown → Task 10. §7 onboarding/catalog → Task 11. Full-access override → Task 2 (`isFullAccess`), applied in Tasks 4-8.
- Open item flagged to the user: the exact JD resume-**generation** trigger (Task 8 Step 1 locates it; if generation has no admin-api route, enforce at the route the frontend calls to start it).
