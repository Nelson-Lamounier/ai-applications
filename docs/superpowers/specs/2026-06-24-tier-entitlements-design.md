# Tier entitlements & Stripe-gated plan changes — design

**Date:** 2026-06-24
**Branch:** `feat/tier-entitlements` (ai-applications); a sibling branch off `develop` in tucaken-app.
**Status:** Approved design, pending implementation plan.

## Problem

The product needs three enforced subscription tiers. Today only fragments exist:
the `users.plan` column defaults to `free` but its CHECK constraint allows only
`('free','pro')`; `ingestion_jobs`/month (3) and resume *imports*/month (1) are
the only enforced quotas; repository-count and project-count limits are marketing
copy with no code behind them; chunk enrichment is gated by an email allowlist
rather than by plan; and `checkout.session.completed` grants `pro`/`active`
without confirming the payment actually succeeded.

The tier-change lockdown the user asked for is, on inspection, already true: the
only writer of `plan`/`subscription_status` is the M2M-gated
`PATCH /api/internal/billing/subscription`, reachable only with a Cognito
`client_credentials` token carrying `write:billing`. No user-JWT route can touch
those columns, and RLS (the `tucaken_app` role) backstops it. This design makes
that property *provable* (assertion + regression test) rather than rebuilding it.

## Target tier model

| tier    | repos | projects | resumes/mo | ingestion jobs/mo | chunk enrichment on sync/build |
|---------|-------|----------|-----------|-------------------|--------------------------------|
| free    | 1     | 1        | 1         | 3 (re-sync allowance) | Tier-1 deterministic only  |
| pro     | ∞     | ∞        | ∞         | ∞                 | Tier-1 deterministic only      |
| premium | ∞     | ∞        | ∞         | ∞                 | full (Bedrock chunk enrichment)|

- **Enrichment** is the differentiator between pro and premium: `tier1` maps to
  worker env `{ENRICHMENT_DISABLED:'1', ENRICH_TIER1:'1'}` (deterministic
  tech→skill resolution, zero Bedrock cost); `full` leaves enrichment enabled so
  `BedrockChunkEnricher` runs.
- All limits are keyed on **effective plan** (trial/active resolution), not the
  raw `plan` column.

### Full-access override (test user)

> **SUPERSEDED (security review):** full access is now driven by the persisted
> `role === 'admin'`, NOT the email allowlists described below. `isFullAccess(role)`
> returns `role === 'admin'`; the test/owner account gets full access via its
> Cognito-admin-group provisioning. This decouples the override from the A/B
> allowlists and is fail-closed. The email-allowlist description that follows is
> retained for history only. See the implementation plan's Global Constraints.

A full-access override grants unlimited everything plus full enrichment,
independent of the user's plan row. It is keyed on the **existing email
allowlist** mechanism (`AB_FREE_TIER_EMAILS` / `ENRICHMENT_TOGGLE_EMAILS`, which
already default to `lamounier_88@hotmail.com`) - not a hardcoded address. The
entitlements module exposes a single `isFullAccess(email)` predicate that the
enforcement points consult first; when true, every quota check short-circuits to
"allowed" and enrichment resolves to `full`. This keeps the override env-driven
and reuses what is already deployed.

## Architecture

### 1. Central entitlements module — single source of truth

New `tucaken-app/admin-api/src/lib/entitlements.ts`:

```ts
export type EffectivePlan = 'free' | 'pro' | 'premium';
export type EnrichmentMode = 'tier1' | 'full';

export interface Entitlements {
  repos: number;                 // Infinity = unlimited
  projects: number;
  resumesPerMonth: number;
  ingestionJobsPerMonth: number;
  enrichment: EnrichmentMode;
}

export const ENTITLEMENTS: Record<EffectivePlan, Entitlements> = {
  free:    { repos: 1,        projects: 1,        resumesPerMonth: 1,        ingestionJobsPerMonth: 3,        enrichment: 'tier1' },
  pro:     { repos: Infinity, projects: Infinity, resumesPerMonth: Infinity, ingestionJobsPerMonth: Infinity, enrichment: 'tier1' },
  premium: { repos: Infinity, projects: Infinity, resumesPerMonth: Infinity, ingestionJobsPerMonth: Infinity, enrichment: 'full' },
};

/** Reads the existing AB_FREE_TIER_EMAILS / ENRICHMENT_TOGGLE_EMAILS allowlists. */
export function isFullAccess(email: string | null | undefined): boolean;

/** Effective entitlements for a user: full-access override first, else the plan map. */
export function entitlementsFor(plan: EffectivePlan, email?: string | null): Entitlements;

/** Worker env for the enrichment mode. */
export function enrichmentEnv(mode: EnrichmentMode): Record<string, string>;
```

Every enforcement point and the ingestion dispatch read from this module. The
frontend `src/features/billing/catalog.ts` copy is realigned to these numbers,
but the **server module is authoritative** — display copy is never a safety
control (consistent with the repo's dispatch-boundary guardrail).

### 2. Migration (ai-applications, numbered + ledgered)

`applications/platform-rds-bootstrap/migrations/103_premium_plan_tier.sql`:

- Drop and re-add the `users.plan` CHECK to allow `('free','pro','premium')`
  (idempotent — guard with constraint existence).
- Extend the `effective_plan` derivation so premium is recognised:
  ```sql
  CASE
    WHEN plan = 'premium' AND subscription_status = 'active' THEN 'premium'
    WHEN plan = 'pro'     AND subscription_status = 'active' THEN 'pro'
    WHEN plan = 'free'    AND trial_ends_at > NOW()          THEN 'trial'
    ELSE 'free'
  END
  ```
  The matching `getUserPlanStatus` query in
  `admin-api/src/lib/repositories/users.ts` is updated to the same CASE.

Follows the checksummed-ledger migration runner; never edits a historical
migration.

### 3. Enforcement points (all source limits from the map, keyed on effective plan)

| Limit            | File / route                                                        | Today                | Change                                                                 |
|------------------|---------------------------------------------------------------------|----------------------|-----------------------------------------------------------------------|
| repos            | `admin-api/src/routes/github.ts` — `connected-repos` POST + `installation` auto-sync | unenforced | count user's connected repos; reject (`429` + `Retry`/upgrade hint) when `>= repos` |
| projects         | `admin-api/src/lib/repositories/projects.ts` + project-create route | unenforced           | cap new projects at `projects`; default 1:1 repo project counts toward it |
| resumes/mo       | JD resume **generation** dispatch route                             | unenforced (only *import* capped) | `usage_quotas` check on `resume_generations` before dispatch         |
| ingestion jobs/mo| `admin-api/src/routes/github.ts` — `getPlanLimit`                   | hardcoded 3 / ∞      | read `ingestionJobsPerMonth` from the map (free=3, pro/premium=∞)      |

`isFullAccess(email)` short-circuits each check to "allowed".

### 4. Enrichment gating by plan

`resolveEnrichmentEnv` in `admin-api/src/lib/ingestion-job.ts` switches from
`isEnrichmentToggleAllowed(email)` to plan-driven: at dispatch (github.ts already
queries the plan), resolve `entitlementsFor(plan, email).enrichment` and emit
`enrichmentEnv(mode)`. The ingestion worker
(`ai-applications/applications/ingestion/src/run-ingestion.ts`) is **unchanged** —
it already resolves `premium` / `free-tier1-only` / `disabled` from those env
vars. Premium → `full`; free/pro → `tier1`; full-access override → `full`.

### 5. Stripe payment hardening

In `tucaken-app/src/server/stripe-webhook.ts`, `onCheckoutCompleted` only grants
`plan` + `subscriptionStatus:'active'` when **`session.payment_status === 'paid'`**.
Otherwise it logs and skips; the subsequent `customer.subscription.updated` /
`invoice.paid` events sync the user once payment truly lands. Verify
`tierForPriceId` (`src/server/stripe.ts`) maps the premium price IDs so a premium
checkout resolves to `plan:'premium'`.

### 6. Tier-change lockdown — make the existing guarantee provable

- Assert the `tucaken_app` role has **no UPDATE privilege on `users.plan`**
  (grants/RLS); document that the sole writer is the M2M `PATCH /subscription`
  on the superuser pool.
- Regression test: a user-JWT request to any route cannot mutate
  `plan` / `subscription_status` / `stripe_*` columns.

### 7. Onboarding

- `plan='free'` remains the default at signup; entitlements are derived from the
  map keyed on plan — **no extra onboarding rows or state**.
- The generated `users.id` (UUID) is **returned to the client via
  `/api/admin/me`** (already returns `id` and `isNew`); the design confirms the
  newly-provisioned UUID is present on the `isNew:true` response so the frontend
  persists it. The provision log event also carries the id for traceability.

## Phasing (for the implementation plan)

1. **Foundation** — migration 103 (premium + effective_plan) + entitlements
   module (`ENTITLEMENTS`, `isFullAccess`, `entitlementsFor`, `enrichmentEnv`) +
   `getUserPlanStatus` premium support.
2. **Enforcement** — repos / projects / resume-generation / ingestion-jobs read
   from the map; full-access override applied.
3. **Enrichment gating by plan** — replace the email allowlist in
   `resolveEnrichmentEnv` with plan-driven resolution.
4. **Stripe payment hardening** — `payment_status==='paid'` gate + premium price
   mapping.
5. **Lockdown & alignment** — role-grant assertion + regression test +
   `catalog.ts` copy realigned + `/me` onboarding-id confirmation.

## Cross-repo split

- **ai-applications:** migration 103, ingestion worker (no change expected —
  verify only). Branch `feat/tier-entitlements`.
- **tucaken-app:** entitlements module, enforcement, `resolveEnrichmentEnv`,
  webhook hardening, catalog copy, tests. Sibling branch off `develop`.

Each repo gets its own branch and PR off `develop`; deploy migration 103 before
the tucaken-app code that depends on the `premium` constraint and the premium
`effective_plan`.

## Out of scope (YAGNI)

Shared workspace / roles, SSO, admin audit log (premium marketing features not
required for this work); annual-vs-monthly price differentiation; per-tier
resume-import limits beyond the single free cap already enforced.
