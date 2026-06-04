# tucaken-smoke MCP — AI-driven E2E smoke testing (design)

**Date:** 2026-06-04
**Status:** Design — pending review
**Scope:** New custom MCP server + AWS Labs MCP integration for reusable, AI-driven smoke testing against the dev account. First reference flow: System Design coach walkthrough.

## 1. Goal

Make end-to-end smoke testing **AI-driven and reusable**: an MCP server exposing the Tucaken smoke-test domain as composable tools, so an agent can trigger pipelines, observe live Bedrock/K8s execution, assert results, and clean up — conversationally, against the dev account — without bespoke per-flow test files. System Design is the first flow proved on it.

## 2. Decisions (locked in brainstorming)

- **Hybrid architecture:** one custom `tucaken-smoke` MCP (domain orchestration + assertions) **+** AWS Labs MCP servers (live observation).
- **Safety:** dev-account-pinned, auto-cleanup, confirm-on-spend.
- **AWS Labs MCPs:** `eks` + `cloudwatch` + read-only gated `aws-api`.
- **v1 scope:** full reusable primitives + System Design flow helpers + logging.
- **Logging:** JSON-lines per session, retain newest 20 files (configurable), prune on startup.

## 3. Architecture

```
Claude Code (agent)
  ├── tucaken-smoke MCP (custom, stdio, AWS_PROFILE=dev-account)   ← drives + asserts
  │     primitives: auth, admin_api, sql(SELECT-only), wait_pipeline, job_logs, cleanup
  │     flows:      run_strategist, run_coach, seed_project_evidence, assert_system_design
  │     cross-cuts: account/region/db pin · confirm-on-spend · auto-cleanup registry · JSON-lines logging
  ├── eks-mcp-server (AWS Labs, read-only)         ← coach Job pods/logs
  ├── cloudwatch logs MCP (AWS Labs, read-only)    ← job + Bedrock logs
  └── aws-api MCP (AWS Labs, read-only, gated)     ← Bedrock invocation metrics + Cost Explorer per-model spend
```

The custom MCP reuses the existing `scripts/smoke/` modules (`cognito-auth`, `admin-api-client`, `rds-client`, `port-forward`, `cleanup-registry`, `discovery`). Those are refactored into a shared library at `scripts/smoke/lib/` imported by **both** the MCP and `just smoke-e2e` — single source of truth, no duplication.

## 4. Components

### 4.1 Custom MCP — `mcp-servers/tucaken-smoke/`
TypeScript stdio server using `@modelcontextprotocol/sdk`. Tools:

**Primitives (flow-agnostic, reusable):**
- `smoke_auth()` — Cognito login as the dev smoke user (from `.env.smoke`); caches the id token for the session; resolves endpoints via the existing `discovery`. Returns a session summary.
- `smoke_admin_api({method, path, body?})` — call any admin-api route with the cached bearer; returns status + JSON. (Generic; covers strategist, coach, status, stages, coaching read.)
- `smoke_sql({sql, params?})` — **SELECT-only** query against dev RDS via an auto-opened, reused port-forward tunnel. Rejects any non-SELECT (regex + first-keyword guard). Read-only.
- `smoke_wait_pipeline({pipelineRunId, timeoutMs?})` — poll `pipeline_runs.status` until `complete`/`failed`/timeout.
- `smoke_job_logs({runId|label})` — status + tail logs of the transient coach/strategist K8s Job (delegates to eks MCP where available; kubectl fallback).
- `smoke_cleanup({scope?})` — run cleanup for rows registered this session (and any matching the smoke-tag filter).

**Flow helpers (compose primitives; thin):**
- `smoke_run_strategist({company, role, jdPath?, confirm})` — startStrategist → wait complete → `{pipelineRunId, applicationId, slug}`. Registers cleanup. **Requires `confirm:true` (Bedrock spend).**
- `smoke_run_coach({slug, interviewStage, confirm})` — `POST /:slug/coach {interviewStage}` → wait coach run → coaching summary. Registers cleanup. **Requires `confirm:true`.**
- `smoke_seed_project_evidence({projectName?, components[]})` — INSERT a minimal project + `project_components` (+ optional decisions) for the test user, for grounded System Design detection. Registers cleanup. (Only write tool; explicit, scoped, tagged.)
- `smoke_assert_system_design({slug, tier})` — fetch `coaching_content('system-design')`; validate Tier A (run completed, row present, `systemDesignCoverage` present, no crash) or Tier B (cards present, every `evidenceRefs.id` ∈ detected coverage, gap cards honest). Returns a structured verdict.

### 4.2 AWS Labs MCP servers (`.mcp.json`, project-scoped)
Launched with `AWS_PROFILE=dev-account`, `AWS_REGION=eu-west-1`, read-only:
- **eks-mcp-server** — inspect coach Job pods, describe, logs.
- **cloudwatch logs MCP** — tail `/job-strategist` Job log group + Bedrock model-invocation logs.
- **aws-api MCP (read-only, gated)** — Bedrock `GetModelInvocationLoggingConfiguration`/CloudWatch metrics + Cost Explorer per-model spend (ties to the bedrock-cost-explorer tracking). Gated = only invoked when the agent explicitly needs cost/metric data.

If a server isn't installable in an environment, the custom MCP's `smoke_job_logs` kubectl fallback keeps the core flow working (graceful degradation).

### 4.3 Safety (cross-cutting, enforced in the MCP)
- **Account/region/db pin:** on startup and per tool, assert resolved AWS account `771826808455`, region `eu-west-1`, db `tucaken`. Any mismatch → tool refuses with a clear error. No way to point it at test/prod.
- **SELECT-only `smoke_sql`:** non-SELECT rejected. Writes only via `smoke_seed_project_evidence` (explicit, tagged, cleanup-registered).
- **Confirm-on-spend:** `smoke_run_strategist`/`smoke_run_coach` require `confirm:true`; without it they return a cost notice and do nothing.
- **Auto-cleanup:** triggering/seeding tools register created ids in a session cleanup registry (reusing `cleanup-registry`); `smoke_cleanup` removes them; a process-exit handler best-effort flushes.

### 4.4 Logging
- `mcp-servers/tucaken-smoke/logs/` (gitignored). One JSON-lines file per session: `smoke-<ISO-timestamp>.log`.
- Each tool call logs `{ts, tool, params(redacted), durationMs, ok, error?}`; failures include the full stack.
- **Retention:** on startup, delete oldest files beyond `SMOKE_LOG_RETAIN` (default 20). Count-based; newest 20 kept.
- Secrets (passwords, tokens, JWTs) redacted before logging.

## 5. Data flow — System Design reference run (Tier A+B)
1. `smoke_auth()` → session.
2. `smoke_seed_project_evidence({components:[{name:'Tenant RLS layer', kind:'backend'}, ...]})` → grounded evidence for the test user.
3. `smoke_run_strategist({company, role, jdPath, confirm:true})` → `{slug}` + analysis persisted.
4. `smoke_run_coach({slug, interviewStage:'system-design', confirm:true})` → coach Job runs → Bedrock → `coaching_content`.
5. (optional) agent uses **eks/cloudwatch MCPs** to watch the Job pod + Bedrock logs live.
6. `smoke_assert_system_design({slug, tier:'B'})` → verdict (grounded cards cite seeded evidence).
7. `smoke_cleanup()` → remove seeded project + application + runs + coaching rows.

## 6. Error handling
- Every tool: structured error in the MCP response **and** the log file; never throws raw.
- Bedrock/job failures surfaced with the Job's pod logs (via `smoke_job_logs`) attached to the verdict so the agent can diagnose.
- Tunnel/auth failures fail fast with the known gotchas referenced (SSM↔GW key sync, admin group) — see the smoke-e2e-env runbook.
- Fail-open cleanup: cleanup errors are logged, not fatal.

## 7. Testing
- Unit (jest): SELECT-only guard, account/region/db pin, log-retention pruning, secret redaction, `assert_system_design` validators (Tier A/B) over fixtures.
- Integration: the System Design reference run against dev (the deliverable smoke test itself).
- No live AWS in unit tests (validators are pure).

## 8. Reusability
Any future smoke flow = compose primitives, or add one `smoke_run_<flow>` + one `smoke_assert_<flow>`. The six primitives are flow-agnostic. The shared `scripts/smoke/lib` keeps the MCP and `just smoke-e2e` aligned.

## 9. Deferred (not v1)
- Write-capable `aws-api` (read-only only).
- Non-dev accounts (hard-pinned out).
- A web dashboard for runs (logs file is the v1 trail).
- Auto-discovery of new flows; flows are added explicitly.

## 10. Build sequence (each ends in a [git-commit skill] commit)
1. Extract `scripts/smoke/` shared modules into `scripts/smoke/lib/` (no behaviour change; `just smoke-e2e` still green).
2. Scaffold `mcp-servers/tucaken-smoke/` (sdk, tsconfig, package.json, account/region pin, JSON-lines logger + retention) + unit tests.
3. Primitives: `smoke_auth`, `smoke_admin_api`, `smoke_sql` (SELECT guard), `smoke_wait_pipeline`, `smoke_cleanup` + tests.
4. `smoke_job_logs` (kubectl fallback) + `.mcp.json` wiring of eks/cloudwatch/aws-api (read-only, dev profile).
5. Flow helpers: `smoke_run_strategist`, `smoke_run_coach`, `smoke_seed_project_evidence`, `smoke_assert_system_design` (+ validators/tests).
6. Run the System Design reference flow against dev; capture results; cleanup.
