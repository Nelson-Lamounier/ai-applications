# E2E Smoke Test — Design

- **Date:** 2026-05-17
- **Status:** Approved (pending written-spec review)
- **Owner:** Nelson Lamounier

## Goal

A manually-triggered, on-demand end-to-end smoke test that exercises the
deployed dev account: it calls the **real, deployed admin-api**
(black-box) the same way the `tucaken-app` frontend does, lets the real
pipelines run on **real Bedrock**, and asserts that **RDS is populated**
with the run's data. Covers job-strategist, article-pipeline,
resume-import, ingestion, and the three chatbots. Run via `just`.

Never wired into normal CI — every run spends real Bedrock budget.

## Scope

In scope (flows verified end-to-end):

- **job-strategist** — admin-api → K8s Job → Bedrock → RDS
- **article-pipeline** — admin-api → K8s Job → Bedrock → RDS/S3
- **resume-import** — admin-api → K8s Job → Bedrock → RDS
- **ingestion** — admin-api → K8s Job → Bedrock → RDS (pgvector)
- **chatbots ×3** — `chatbot` / `chatbot-public` / `chatbot-authenticated`
  via their API Gateway endpoints (NOT fronted by admin-api)

Out of scope: `self-healing`, `platform-job-watcher`,
`platform-rds-bootstrap` (no externally-triggerable product flow / no LLM
path a user initiates).

## Approach

**Approach A (chosen): trigger via deployed admin-api, poll RDS for the
terminal state.** The orchestrator discovers endpoints, calls the real
admin-api route to start each pipeline, then polls
`pipeline_runs.status` (via a port-forwarded pgbouncer) until terminal,
then asserts the expected rows/columns and cleans them up. It depends
only on the **RDS schema** — the stable seam both repos share — never on
admin-api internals, so it survives `tucaken-app` changes.

Rejected: (B) polling an admin-api status endpoint — no admin-api
contract exists in this repo, building on an unknown route is fragile;
(C) tailing K8s Job pod logs — couples the test to pod naming/log
strings, flaky, no extra signal over DB polling.

## Architecture

```
just smoke-e2e [flows…]  ->  scripts/smoke-e2e.ts (orchestrator, tsx)
  ├─ resolve dev-account creds  (aws configure export-credentials --profile dev-account)
  ├─ discovery.ts               (endpoints + secrets)
  │     ├─ admin-api base URL   ← kubectl -n admin-api port-forward svc/admin-api 13002:3002
  │     ├─ admin-api auth token ← kubectl -n admin-api get secret <token-secret> -o jsonpath
  │     ├─ chatbot URLs (×3)    ← aws ssm get-parameter (CDK-written params)
  │     └─ PG password          ← kubectl -n platform get secret platform-rds-credentials
  ├─ kubectl -n platform port-forward svc/pgbouncer 15432:5432
  ├─ select flows from argv
  ├─ jest --config scripts/smoke/jest.smoke.config.cjs --runInBand <selected>
  └─ finally: cleanup registered rows + kill port-forwards
```

### Components (each independently testable)

- **`scripts/smoke-e2e.ts`** — orchestrator: cred resolution, discovery,
  port-forward lifecycle, jest invocation, summary table, `finally`
  cleanup. Owns exit code (non-zero if any flow failed).
- **`scripts/smoke/discovery.ts`** — returns one typed `Endpoints`
  object. All `kubectl`/`aws` calls go through a single **`execFile`**
  wrapper reusing the existing `src/utils/execFileNoThrow.ts`
  (execFile, no shell — no command injection from any discovered
  value); the module is unit-mockable via that wrapper. `NAME_PREFIX`
  from env default `bedrock-data-development`, overridable via
  `SMOKE_NAME_PREFIX`.
- **`scripts/smoke/rds-client.ts`** — `pg` Pool wrapper:
  `waitForPipelineStatus(runId, terminal, timeout)`,
  `assertRowsForUser(userId, table, predicate)`,
  `cleanupRun(runId, userId)` (FK-ordered, parameterised SQL only),
  plus the **safety guard** (below).
- **`scripts/smoke/admin-api-client.ts`** — typed `fetch` wrapper:
  `startStrategist`, `startArticle`, `startImport`, `startIngestion`;
  returns the admin-api-allocated `pipeline_run_id`.
- **`scripts/smoke/admin-api-contract.ts`** — ⚠ **filled from
  `tucaken-app`**: route paths, request body shapes, the admin-api
  token-secret name, and the auth header scheme (Bearer vs x-api-key).
  Single documented config file; placeholders until confirmed.
- **`scripts/smoke/cleanup-registry.ts`** — collects run ids / slugs /
  S3 keys for the `finally` cleanup.
- **Per-flow jest suites** — `scripts/smoke/<flow>.smoke.test.ts`.

All external process calls (`kubectl`, `aws`) use `execFile`-style
invocation with argument arrays — never a shell string — so a
discovered secret or URL can never be interpreted as a command.

## Endpoint & credential discovery

| Target | Source (dev-account) | Mechanism |
|---|---|---|
| admin-api base URL | ClusterIP `svc/admin-api:3002` ns `admin-api` (no public Ingress) | `kubectl -n admin-api port-forward svc/admin-api 13002:3002` → `http://127.0.0.1:13002` |
| admin-api auth token | k8s secret ns `admin-api` | `kubectl -n admin-api get secret <token-secret> -o jsonpath` (name in `admin-api-contract.ts`) |
| chatbot URLs ×3 | CDK-written SSM params `/<NAME_PREFIX>/api-url`, `/chatbot-public-api-url`, `/chatbot-authenticated-api-url`; paths `/invoke`, `/invoke-public`, `/invoke-authenticated` | `aws ssm get-parameter --profile dev-account` |
| PG password | secret `platform-rds-credentials` ns `platform` | `kubectl get secret … -o jsonpath` |
| RDS reachability | pgbouncer ns `platform` | `kubectl -n platform port-forward svc/pgbouncer 15432:5432` |

Two port-forwards (admin-api 13002, pgbouncer 15432) started by the
orchestrator, torn down in `finally`, TCP-health-checked after start.

## Per-flow contracts

Each suite: **trigger → poll → assert → register rows for cleanup.**

### job-strategist (`job-strategist.smoke.test.ts`)
- Input: fixed `TEST_USER_ID`, static JD fixture, an existing dev resume
  id (`SELECT id FROM resumes WHERE user_id=$1 LIMIT 1`;
  skip-with-message if none).
- Trigger: `POST admin-api <strategist route>` → `pipeline_run_id`.
- Poll: `pipeline_runs.status` → `complete` (fail on `failed`/timeout).
- Assert: `pipeline_runs.status='complete'`; ≥1 row in
  `job_applications`, `resumes` (tailored), `coaching_content` for the
  run; key JSONB columns non-empty.

### article-pipeline (`article-pipeline.smoke.test.ts`)
- Input: tiny markdown draft uploaded to the dev assets S3 bucket under
  `smoke/<runId>/…`; `TEST_USER_ID`.
- Trigger: `POST admin-api <article route>` → `pipeline_run_id`.
- Poll: `pipeline_runs.status` → `complete`.
- Assert: `articles` row for the run, `status in ('review','published')`,
  content/MDX non-empty.

### resume-import (`resume-import.smoke.test.ts`)
- Input: fixture PDF
  (`applications/resume-import-processor/src/parsers/__tests__/fixtures/Nelson_Lamounier_Resume.pdf`)
  uploaded to assets bucket under `smoke/<runId>/…`.
- Trigger: `POST admin-api <import route>` → run id.
- Assert: enriched `user_career_history` rows for `TEST_USER_ID`.

### ingestion (`ingestion.smoke.test.ts`)
- Input: a small public GitHub repo full-name constant.
- Trigger: `POST admin-api <ingestion route>` → run id.
- Assert: `document_embeddings` rows + `repo_sync_state` complete for
  `TEST_USER_ID`.

### chatbots ×3 (`chatbots.smoke.test.ts`) — synchronous, no admin-api
- `POST <api-url>/invoke`, `/invoke-public`, `/invoke-authenticated`
  with a fixed question; authenticated needs a dev JWT (from
  `admin-api-contract.ts` / k8s secret; skip-with-warning if absent).
- Assert: 200, non-empty answer; authenticated also persists a
  chat-history row for `TEST_USER_ID` (then cleaned).

Fixtures are real but minimal to bound Bedrock spend while still
exercising the full path. Missing preconditions **skip with a clear
message** — never silent-pass, never hard-fail.

## Data lifecycle & cleanup

- **Identity:** one fixed `TEST_USER_ID` (env `SMOKE_TEST_USER_ID`,
  default existing `31f4686a-979b-4765-a17c-22a1e71cec59`). Each trigger
  records its `pipeline_run_id`/`slug` into `CleanupRegistry`.
- **Scope:** run-scoped deletes where a run id exists (precise,
  parallel-safe); user-scoped fallback **bounded to `TEST_USER_ID`** for
  tables without a run fk (`document_embeddings`, `user_career_history`).
- **FK-ordered cascade** in `cleanupRun(runId,userId)`:
  ```
  coaching_content → resumes(tailored) → articles → pipeline_runs
  → job_applications
  user_career_history          (user + import scoped)
  document_embeddings, repo_sync_state   (user + repo scoped)
  chat history rows            (user + session scoped)
  ```
  Each delete is idempotent, parameterised, and per-table-wrapped (one
  missing table never aborts the rest).
- **S3 fixtures** uploaded under `smoke/<runId>/…`, deleted in the same
  `finally`.
- **Trigger:** `finally` cleans every registered run **even on
  failure/timeout**, unless `SKIP_CLEANUP=1` (retain for debugging;
  prints what was kept + the manual cleanup SQL).
- **Pre-run hygiene:** `--clean-first` purges stale `TEST_USER_ID` smoke
  rows before starting.
- **Safety guard (most important rule):** cleanup hard-aborts with no
  deletes if the resolved DB name is not the dev database, or if
  `TEST_USER_ID` is empty / does not match the expected test-user
  shape. Prevents ever pointing this at prod.

## Error handling & timeouts

- **Fail fast on setup:** missing creds, failed port-forward,
  unresolved endpoint, absent PG password → abort before any Bedrock
  spend, non-zero exit, remediation message.
- **Per-flow timeout:** `SMOKE_FLOW_TIMEOUT` (default 600s), 5s poll
  interval. On timeout: fail with last-seen status + `error` column;
  cleanup still runs.
- **Pipeline failure surfaced:** `status='failed'` → assertion fails
  with the run's failure JSONB + `pipeline_run_id` for `kubectl logs`.
- **admin-api non-2xx:** status+body logged, suite fails, nothing
  registered (no run started).
- **Port-forward resilience:** TCP health-check after start; a dropped
  pgbouncer forward surfaces a distinct "infra, not product" error
  class so flakes aren't misread as product regressions.
- **Isolation:** `--runInBand`, suites independent; jest continues on
  one flow's failure; orchestrator exit non-zero if any failed. End
  summary: per-flow PASS/FAIL/SKIP + duration + Bedrock-cost note.
- **No Bedrock retries** — a real failure is the health signal;
  retrying masks regressions and doubles spend.

## File layout

```
scripts/
  smoke-e2e.ts
  smoke/
    discovery.ts
    rds-client.ts
    admin-api-client.ts
    admin-api-contract.ts        # ⚠ fill from tucaken-app
    cleanup-registry.ts
    fixtures/
      article-draft.md
      strategist-jd.txt          # resume PDF reused from resume-import fixtures
    job-strategist.smoke.test.ts
    article-pipeline.smoke.test.ts
    resume-import.smoke.test.ts
    ingestion.smoke.test.ts
    chatbots.smoke.test.ts
    jest.smoke.config.cjs        # testMatch *.smoke.test.ts, runInBand, 600s
    README.md                    # prerequisites + tucaken-app values to fill
```

## Runner — justfile

Test execution is via `just`, mirroring the existing
`test-strategist-integration` recipe (`.env.<name>` additive loading,
`*ARGS` overrides, `[group(...)]` tag):

```just
# ── E2E Smoke (real Bedrock, dev account — never in CI) ──────────────────────

# Run the end-to-end smoke suite against the deployed dev account.
# Usage: just smoke-e2e                 # all flows
#        just smoke-e2e job-strategist  # one flow
#        just smoke-e2e chatbots SKIP_CLEANUP=1
[group('smoke')]
smoke-e2e *ARGS:
    #!/usr/bin/env bash
    set -euo pipefail
    if [[ -f .env.smoke ]]; then
      while IFS='=' read -r key value || [[ -n "$key" ]]; do
        [[ "$key" =~ ^[[:space:]]*# ]] && continue
        [[ -z "${key// }" ]] && continue
        key="${key// /}"; value="${value// /}"
        [[ -n "$value" && -z "${!key:-}" ]] && export "$key=$value"
      done < .env.smoke
    fi
    flows=(); overrides=()
    for arg in {{ARGS}}; do
      if [[ "$arg" == *=* ]]; then overrides+=("$arg"); else flows+=("$arg"); fi
    done
    for o in "${overrides[@]:-}"; do [[ -n "$o" ]] && export "$o"; done
    npx tsx scripts/smoke-e2e.ts "${flows[@]:-all}"

# Open the pgbouncer tunnel for manual inspection during a smoke run.
[group('smoke')]
smoke-tunnel:
    kubectl port-forward svc/pgbouncer 15432:5432 -n platform
```

`AWS_PROFILE` defaults to `dev-account`. Env knobs: `SMOKE_TEST_USER_ID`,
`SMOKE_NAME_PREFIX`, `SMOKE_FLOW_TIMEOUT`, `SKIP_CLEANUP`,
`--clean-first`. No `package.json` script and no CI workflow entry —
`just smoke-e2e` is the only entrypoint.

## Harness self-tests (TDD)

`discovery.ts`, `rds-client.ts` (especially FK delete order **and the
dev-DB / test-user safety guard**), and `cleanup-registry.ts` get unit
tests with a mocked `execFile` wrapper / `pg`, written test-first. The
cleanup guard is proven before it can ever touch the dev DB. These unit
tests *are* allowed in normal CI (they mock everything; no Bedrock, no
AWS).

## Open items to confirm before first run

1. `admin-api-contract.ts`: exact route paths + request body shapes for
   strategist / article / import / ingestion starts.
2. admin-api token-secret name + auth header scheme.
3. `chatbot-authenticated` dev JWT source.
4. `NAME_PREFIX` actual value for the dev SSM params.

All are isolated to `admin-api-contract.ts` / discovery config; the
harness is built and unit-tested around them with documented
placeholders.
