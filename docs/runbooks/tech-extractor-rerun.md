---
title: Re-extract a user/repo's technology facts
type: runbook
tags: [operations, tech-extractor, ingestion, kubernetes, postgres, ontology]
sources:
  - applications/ingestion/src/facts/run-facts-stage.ts
  - applications/ingestion/src/run-ingestion.ts
  - applications/ingestion/README.md
  - applications/shared/src/rds/implementations/TechnologyOntologyRepository.ts
created: 2026-05-27
updated: 2026-07-18
---

> **Now runs inside unified ingestion (2026-07-18).** The standalone
> `tech-extractor` Job this runbook originally targeted has been
> retired. There is no longer a way to re-extract facts on their own —
> re-extraction is a side effect of re-running the `ingestion` Job for
> the repo, which always runs the facts stage in-process
> (`UNIFIED_INGESTION=on`, the dispatched default). One capability the
> old standalone Job had is genuinely gone: **there is no way to pin a
> rerun to a historical commit SHA.** `run-ingestion.ts` always resolves
> the repo's current HEAD via `repoAdapter.getHeadCommitSha()`
> ([applications/ingestion/src/run-ingestion.ts:1032](../../applications/ingestion/src/run-ingestion.ts#L1032))
> before fetching the tarball — a rerun re-extracts *today's* HEAD, not
> an arbitrary past revision. See
> [docs/projects/tech-extractor.md](../projects/tech-extractor.md) for
> the retirement note.

## When to run this

Three legitimate reasons to trigger a re-ingestion for a
`(userId, repoFullName)` pair:

- **Ontology version bump.** New aliases were merged that should now
  match previously-unmatched candidates. `technology_evidence` rows
  carry the `extracted_at_ontology_version` they were extracted under
  ([applications/shared/src/rds/implementations/TechnologyEvidenceRepository.ts:48-74](../../applications/shared/src/rds/implementations/TechnologyEvidenceRepository.ts#L48-L74)),
  so a rerun creates the next-version rows alongside the old ones.
- **Detector strengthening.** A new extractor or scanner has landed
  and you want existing evidence regenerated against it rather than
  waiting for the next natural ingestion.
- **Corrupt or failed run.** An earlier Job failed mid-run; you want a
  clean replacement. (For a *user's own* repo, the self-service
  `POST /connected-repos/:fullName/retry` route in `tucaken-app`'s
  admin-api already does this without operator involvement — this
  runbook is for the operator-initiated case.)

Do **not** run this for routine re-ingestion — natural ingestion
re-runs the facts extractors automatically on every push to the
user's tracked repo (via the platform's webhook-driven sync).

## Prerequisites

- AWS read access to SSM (`admin-api-job-images` Secret; the image URI
  is file-mounted into the admin-api pod)
- Admin credentials against `tucaken-app`'s admin-api (the trigger
  route is admin-only)
- The exact `userId` (platform `users.id`, not the Cognito sub) and
  `repoFullName` (`owner/repo`) you want to re-extract
- `kubectl` access to the `k8s-eks-development` cluster's `ingestion`
  namespace, if you want to tail the Job directly rather than poll
  `sync-status`

## Procedure

### 1. Confirm current ontology version

```bash
psql -h "$PG_HOST" -U "$PG_USER" -d "$PG_DATABASE" -c \
  "SELECT version FROM ontology_version WHERE singleton = TRUE;"
```

`technology_evidence` rows produced by your rerun will be tagged with
this version. The old rows (at an earlier version) remain — you have a
side-by-side comparison for free.

### 2. Dispatch the rerun

The rerun mechanism is the admin ingestion-trigger route in
`tucaken-app`'s admin-api (`src/routes/github/ingestion.ts`), which
builds the Job spec via `buildIngestionJobSpec`
(`src/lib/jobs/ingestion-job.ts`) and creates it directly against the
cluster's `ingestion` namespace — there is no separate `kubectl create`
step to hand-author, unlike the retired standalone Job:

```bash
curl -X POST "https://<admin-api-host>/api/admin/ingestion/trigger" \
  -H "Authorization: Bearer <admin-token>" \
  -H "Content-Type: application/json" \
  -d '{
        "repoFullName": "<owner>/<repo>",
        "forceReindex": true
      }'
```

`repoFullName` must match `owner/repo`. `forceReindex` is optional
(default `false`); set it `true` to force a full re-embed rather than
the incremental blob-SHA diff path — for a pure facts-only rerun
(ontology bump, detector strengthening) you usually want
`forceReindex: false`, since the facts stage runs on every dispatch
regardless. The route dedups against an in-flight sync
(`tryClaimSyncSlot`) and returns `{ status: 'already_running', ... }`
rather than double-dispatching if one is already running for that
`(userId, repoFullName)`.

The `userId` is resolved server-side from the caller's own
authenticated session on the two user-facing routes; the admin trigger
route takes the operator's own authenticated `userId`, so re-extracting
*another* user's repo as an operator requires impersonation/service
tooling outside this route's contract — check with the platform owner
before assuming it is possible.

### 3. Watch the Job to completion

```bash
JOB=$(kubectl -n ingestion get pods \
  -l app=ingestion-worker \
  --sort-by=.metadata.creationTimestamp \
  -o jsonpath='{.items[-1:].metadata.name}')
kubectl -n ingestion logs "$JOB" -f
```

A successful run emits an `event: 'unified_facts.complete'` structured
log line with `evidenceKeys`, `failedExtractors`, and `durationMs`
([applications/ingestion/src/run-ingestion.ts:861-867](../../applications/ingestion/src/run-ingestion.ts#L861-L867))
partway through the Job (facts run before chunking), followed by the
Job's own overall completion log.

### 4. Verify the new evidence

```bash
psql -h "$PG_HOST" -U "$PG_USER" -d "$PG_DATABASE" <<SQL
SELECT
  extracted_at_ontology_version AS ontology_version,
  source_layer,
  COUNT(*) AS row_count,
  COUNT(DISTINCT technology_id) FILTER (WHERE technology_id IS NOT NULL) AS matched_canonicals
FROM technology_evidence
WHERE user_id = '${USER_ID}'
  AND repo_full_name = '${REPO}'
GROUP BY extracted_at_ontology_version, source_layer
ORDER BY extracted_at_ontology_version DESC, source_layer;
SQL
```

The newest `ontology_version` rows should be the rerun output. If
`matched_canonicals` for the new rows is materially higher than the
old rows, the rerun closed gaps — which is the point.

## Verification

- Job exit code is 0 (`kubectl get jobs -n ingestion … -o
  jsonpath='{.status.succeeded}'` returns `1`)
- `unified_facts.complete` log line present with `failedExtractors: []`
  (a non-empty array means at least one extractor family crashed — see
  [docs/troubleshooting/tech-extractor-stuck-extraction.md](../troubleshooting/tech-extractor-stuck-extraction.md))
- `sync-status` for the repo (via `GET /connected-repos/sync-status`)
  transitions to a terminal state rather than staying `pending`/`syncing`

There is no Prometheus recall gauge to check any more — the standalone
Job's `tech_extractor_layer1_recall` metric was retired with it (see
[docs/concepts/tech-extractor-architecture.md](../concepts/tech-extractor-architecture.md#implementation-in-this-codebase)).
`matched_canonicals` per `source_layer` from the query above is the
useful signal.

## Rollback

The rerun creates *new* rows; it does **not** delete the old ones.
There is no "undo" required — the previous extraction's rows remain at
their original `ontology_version` for audit. If you specifically want
to keep only one version of evidence per (user, repo) pair, that is a
downstream concern owned by whoever queries `technology_evidence`
(typically the
[projects clustering](../../applications/shared/src/projects/)) and
should be expressed as `WHERE extracted_at_ontology_version = (SELECT
version FROM ontology_version WHERE singleton = TRUE)`.

If the Job itself misbehaves (OOM, stuck, runaway), see
[docs/troubleshooting/tech-extractor-stuck-extraction.md](../troubleshooting/tech-extractor-stuck-extraction.md)
for diagnosis. Delete a stuck Job with:

```bash
kubectl -n ingestion delete "$JOB"
```

This terminates the pod; any partial Postgres writes already committed
remain (`insertMany` is one transaction per call, so a mid-Job kill
loses unwritten in-memory rows but does not corrupt the table).

<!--
Evidence trail (auto-generated):
- Source: applications/ingestion/src/run-ingestion.ts (lines 680-1060 on 2026-07-18)
- Source: applications/ingestion/src/facts/run-facts-stage.ts (read on 2026-07-18)
- Source: applications/ingestion/README.md (read on 2026-07-18)
- Source: applications/shared/src/rds/implementations/TechnologyEvidenceRepository.ts (lines 40-75 on 2026-07-18)
- Source: applications/shared/src/rds/implementations/TechnologyOntologyRepository.ts (currentVersion, lines 455-461 on 2026-07-18)
- Source (sibling repo, cited for the trigger route contract): tucaken-app/admin-api/src/routes/github/ingestion.ts (read on 2026-07-18)
- Source (sibling repo): tucaken-app/admin-api/src/lib/jobs/ingestion-job.ts (read on 2026-07-18)
- Source (sibling repo): tucaken-app/admin-api/src/lib/config.ts (ingestionNamespace default, on 2026-07-18)
-->
