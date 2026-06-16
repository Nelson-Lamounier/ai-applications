---
title: User-scoped tables and RLS
type: concept
tags: [postgres, rls, schema, multi-tenant, user-data, security]
sources:
  - applications/platform-rds-bootstrap/src/bootstrap.ts
  - applications/platform-rds-bootstrap/migrations/
created: 2026-06-16
updated: 2026-06-16
---

## Overview

Almost every table that holds user data carries a `user_id` and is protected by
Row-Level Security, so a query can only ever see the rows of the current user.
This is the catalogue of those tables, what each handles, and which migration
creates it. The base tables come from the bootstrap DDL; the rest from numbered
migrations.

## How isolation works

Each user-scoped table has an RLS policy of the form
`USING (user_id = current_setting('app.current_user_id', true)::uuid)`, and the
caller sets `app.current_user_id` **per transaction** before querying. The
mechanism and call sites are documented in
[per-transaction-rls](../patterns/per-transaction-rls.md); the repository layer
that wraps it is [hexagonal-rds-architecture](../patterns/hexagonal-rds-architecture.md).

## Identity and billing

| Table | Created in | Handles |
| :- | :- | :- |
| `users` | bootstrap DDL | core identity — email, profile, plan, role, trial dates |
| `user_identities` | `005_user_identities.sql` | maps each Cognito sub → `users.id` (one per provider) |
| `oauth_connections` | bootstrap DDL | GitHub OAuth/App tokens, KMS-encrypted (see [ADR 0008](../decisions/0008-oauth-token-envelope-encryption.md)) |
| `usage_quotas` | `007_reverse_trial.sql` | monthly per-feature counters (see usage-quota docs in tucaken-app) |
| `plan_events` | `007_reverse_trial.sql` | audit log — trial started / upgraded / canceled / expired |
| `trial_nudges` | `007_reverse_trial.sql` | de-dupes day-7 / day-12 trial nudges |

Who creates the `users` / `user_identities` / `plan_events` rows (the admin-api
provisions them on the first authenticated request) is documented in the sibling
**`tucaken-app`** repo, since that code lives there.

## Repository ingestion and profile

| Table | Created in | Handles |
| :- | :- | :- |
| `document_embeddings` | bootstrap DDL | ingested repo chunks — raw `content` + `embedding` (see [ingestion-storage-schema](ingestion-storage-schema.md)) |
| `repository_profiles` | `014_repository_profiles.sql` | per-repo extracted identity (tech_stack, quality, classification) |
| `repository_profile_embeddings` | `014_repository_profiles.sql` | typed summary chunks (one_liner / description / highlight) + embedding |
| `repo_sync_state` | bootstrap DDL | ingestion progress — status, file/chunk counts, phase |
| `repo_file_state` | `048_repo_file_state.sql` | file-level state for selective re-sync |
| `repo_commits` / `repo_pull_requests` | `045_repo_commits_pulls.sql` | git commit / PR evidence per repo |
| `user_profile_rollup` | `024_user_profile_rollup.sql` | synthesised code-grounded profile (see [profile-intelligence](profile-intelligence.md)) |

## Projects and the JD/resume/coach workflow

| Table | Created in | Handles |
| :- | :- | :- |
| `projects` / `project_components` | `030_projects.sql` | case-study projects grouping repos + their parts |
| `job_applications` | bootstrap DDL | applications + kanban status |
| `resumes` | bootstrap DDL | generated resumes per application |
| `interview_stages` | bootstrap DDL | per-stage interview prep |
| `coaching_content` | bootstrap DDL | interview coaching output (scoped via the application FK) |
| `resume_imports` / `user_career_history` / `experience_embeddings` | `010_resume_import_pipeline.sql` | résumé parse pipeline + extracted history + its embeddings |

## Async jobs, cost, and chat

| Table | Created in | Handles |
| :- | :- | :- |
| `pipeline_runs` | bootstrap DDL | async job status (article / strategist / ingestion / coach / case-study) |
| `prompt_invocations` | `011_prompt_observability.sql` | per-Bedrock-call cost + observability ledger |
| `ingestion_audit_log` | bootstrap DDL | ingestion audit trail per user/repo |
| `api_keys` | bootstrap DDL | user API keys for external integrations |
| `chat_sessions` / `chat_messages` | `015_chat_sessions.sql` | authenticated chatbot sessions + messages |

## Tradeoffs

Tagging every table with `user_id` + an RLS policy makes cross-user data exposure a
policy violation the database itself rejects, not something application code must
remember — at the cost of every query path setting `app.current_user_id` first
(enforced by the repository layer). Splitting identity (`users`/`user_identities`)
from feature data (everything else) keeps the identity surface small and lets
feature rows be created lazily on first use rather than provisioned up front.

## Related concepts

- [rds-bootstrap-and-migrations](rds-bootstrap-and-migrations.md) — how these tables get created
- [per-transaction-rls](../patterns/per-transaction-rls.md)
- [ingestion-storage-schema](ingestion-storage-schema.md)

<!--
Evidence trail (auto-generated):
- Source: applications/platform-rds-bootstrap/src/bootstrap.ts (read on 2026-06-16, base DDL tables)
- Source: applications/platform-rds-bootstrap/migrations/ (mapped on 2026-06-16: 005, 007, 010, 011, 014, 015, 024, 030, 045, 048)
-->
