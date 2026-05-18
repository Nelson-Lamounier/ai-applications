# E2E Smoke Test

Real Bedrock + real RDS, dev account only. **Never runs in CI.**
Black-box: triggers the deployed admin-api, polls RDS to a terminal
state, asserts the rows, then cleans up everything it wrote.

## Prerequisites
- `aws sso login --profile dev-account` (or valid `dev-account` creds)
- `kubectl` context pointing at the dev cluster
- `just`, Node, repo deps installed (`npm ci`)
- A dedicated **dev Cognito test user** (throwaway). Its `sub` becomes
  the `TEST_USER_ID`; a fresh JWT is minted per run.

## Configure (before the FIRST run)
```
cp .env.smoke.example .env.smoke
# fill SMOKE_COGNITO_USERNAME / SMOKE_COGNITO_PASSWORD
```
`.env.smoke` is gitignored and loaded by `just smoke-e2e`. Only the two
Cognito credentials are required — everything else (chatbot URLs + api
key, Cognito client id, RDS database/user/password) is auto-discovered
from SSM and the `platform` / `admin-api` k8s secrets.

The admin-api lives in the separate **tucaken-app** repo, so its routes
and request/response field names cannot be code-verified from here.
The defaults in `admin-api-contract.ts` are the verified routes and the
response id is normalised across `pipelineRunId | pipeline_run_id | id`
plus `applicationId` / `importId` / `slug`. **Confirm the routes and
body field names against tucaken-app before the first live run**;
override via the `SMOKE_ROUTE_*` vars if they differ.

## Run
```
just smoke-e2e                  # all flows
just smoke-e2e job-strategist   # one flow
just smoke-e2e chatbots SKIP_CLEANUP=1
just smoke-e2e all --clean-first
```

## Flows & assertions
| flow | trigger | terminal check | asserts |
|---|---|---|---|
| job-strategist | `POST /api/admin/pipelines/strategist-job` | `pipeline_runs.status='complete'` | `job_applications` + linked `resumes` + `coaching_content` |
| article-pipeline | `POST /api/admin/pipelines/article-job` | `pipeline_runs.status='complete'` | `articles` by slug+author, status review/published, non-empty body |
| resume-import | 3-step presigned upload + `…/:id/complete` | `resume_imports.status='completed'` | `user_career_history` for the import |
| ingestion | `POST /api/admin/ingestion/trigger` | `repo_sync_state.sync_status='complete'` | `document_embeddings` for user+repo |
| chatbots ×3 | direct Lambda `/invoke[-public\|-authenticated]` | HTTP 200 | non-empty answer; authenticated persists & cleans a session |

## Cleanup linkage
There are no `pipeline_run_id` FKs in the schema. `cleanupRun` deletes
children → parents, always TEST_USER scoped:
- job-strategist: `coaching_content` → `resumes` → `job_applications` → `pipeline_runs` (by `applicationId`)
- article-pipeline: `articles` (slug+author_id) → `pipeline_runs`
- resume-import: `user_career_history` (cascades `experience_embeddings`) → `resume_imports` (by `importId`)
- ingestion: `document_embeddings` → `repo_sync_state` (by `repo_full_name`)
- chatbots: `chat_messages` → `chat_sessions` (by returned session id)

`SKIP_CLEANUP=1` retains rows and prints what was kept.

## Safety
`assertSafeToMutate` hard-aborts (no DB work) unless the resolved DB is
in `SMOKE_ALLOWED_DBS` (default `tucaken`, read per-call, fails closed on
blank) **and** `TEST_USER_ID` is a UUID. Cleanup is test-user scoped
only — it can never touch another user's rows or a non-dev database.
