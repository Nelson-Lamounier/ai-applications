# E2E Smoke Test

Real Bedrock + real RDS, dev account only. **Never runs in CI.**

## Prerequisites
- `aws sso login --profile dev-account` (or valid `dev-account` creds)
- `kubectl` context pointing at the dev cluster
- `just`, Node, repo deps installed (`npm ci`)

## Run
```
just smoke-e2e                  # all flows
just smoke-e2e job-strategist   # one flow
just smoke-e2e chatbots SKIP_CLEANUP=1
just smoke-e2e all --clean-first
```

## Before the FIRST run — fill tucaken-app values
Set these in a gitignored `.env.smoke` (or real env). Defaults in
`scripts/smoke/admin-api-contract.ts` are placeholders:

| var | meaning |
|---|---|
| `SMOKE_ROUTE_STRATEGIST` / `_ARTICLE` / `_IMPORT` / `_INGESTION` | admin-api route paths |
| `SMOKE_ADMIN_TOKEN_SECRET` / `SMOKE_ADMIN_TOKEN_KEY` | k8s secret holding the admin-api token |
| `SMOKE_ADMIN_AUTH_SCHEME` | `bearer` or `x-api-key` |
| `SMOKE_CHATBOT_JWT_SECRET` / `SMOKE_CHATBOT_JWT_KEY` | dev JWT for chatbot-authenticated (omit ⇒ skipped) |
| `SMOKE_NAME_PREFIX` | SSM param prefix (default `bedrock-data-development`) |
| `SMOKE_ASSETS_BUCKET` | dev assets S3 bucket for draft/PDF upload |
| `SMOKE_TEST_USER_ID` | UUID test user (default `31f4686a-…`) |
| `SMOKE_FLOW_TIMEOUT` | per-flow ms (default 600000) |
| `SMOKE_INGEST_REPO` | repo full-name for ingestion (default `sindresorhus/is`) |
| `SKIP_CLEANUP=1` | retain rows for debugging |

Also re-verify `rds-client` column names against
`applications/platform-rds-bootstrap/src/index.ts` and
`applications/job-strategist/src/__tests__/run-pipeline.integration.test.ts`.

## Safety
`assertSafeToMutate` hard-aborts unless the DB is in `SMOKE_ALLOWED_DBS`
(default `tucaken`) and `SMOKE_TEST_USER_ID` is a UUID. Cleanup is
test-user-scoped only.
