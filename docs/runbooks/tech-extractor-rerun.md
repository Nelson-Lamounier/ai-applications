---
title: Re-extract a user/repo with tech-extractor
type: runbook
tags: [operations, tech-extractor, kubernetes, postgres, ontology]
sources:
  - applications/tech-extractor/src/run-tech-extract.ts
  - applications/tech-extractor/src/env.ts
  - applications/shared/src/rds/implementations/TechnologyOntologyRepository.ts
created: 2026-05-27
updated: 2026-05-27
---

## When to run this

Three legitimate reasons to re-extract a `(userId, repoFullName)` pair:

- **Ontology version bump.** New aliases were merged that should now
  match previously-unmatched candidates. `technology_evidence` rows
  carry the `ontology_version` they were extracted under
  ([applications/tech-extractor/src/orchestrator/TechExtractOrchestrator.ts:56](../../applications/tech-extractor/src/orchestrator/TechExtractOrchestrator.ts#L56)),
  so a rerun creates the next-version rows alongside the old ones.
- **Detector strengthening.** A new extractor or scanner has landed
  (e.g. the F4 prefix-guarded bigram path) and you want existing
  evidence regenerated against it rather than waiting for the next
  natural ingestion.
- **Corrupt extraction.** An earlier Job failed mid-run; you want a
  clean replacement.

Do **not** run this for routine re-ingestion — natural ingestion
re-runs the extractor automatically on every push to the user's
tracked repo.

## Prerequisites

- `kubectl` access to the cluster the Job will run in
- AWS read access to SSM (`/k8s/<env>/job-images/tech-extractor` for
  the current image URI; the per-Job credentials live in K8s Secrets)
- The exact `userId` (UUID) and `repoFullName` (`owner/repo`) you
  want to re-extract
- Optional: a specific `commitSha` if you want to pin the rerun to a
  past revision rather than today's `HEAD`

## Procedure

### 1. Confirm current ontology version

```bash
psql -h "$PG_HOST" -U "$PG_USER" -d "$PG_DATABASE" -c \
  "SELECT version FROM ontology_version WHERE singleton = TRUE;"
```

`technology_evidence` rows produced by your rerun will be tagged with
this version
([applications/shared/src/rds/implementations/TechnologyOntologyRepository.ts:43-49](../../applications/shared/src/rds/implementations/TechnologyOntologyRepository.ts#L43-L49)).
The old rows (at an earlier version) remain — you have a side-by-side
comparison for free.

### 2. Confirm the current Job image

```bash
aws ssm get-parameter \
  --name "/k8s/${env}/job-images/tech-extractor" \
  --query 'Parameter.Value' --output text
```

This is the image URI the K8s Job spec will pull. Confirm it matches
the version of the extractor you intend to run (e.g. F4-enabled, or a
specific commit SHA after a parity-relevant fix).

### 3. Spawn a one-shot Job

The Job spec lives in the sibling `kubernetes-platform` /
`kubernetes-bootstrap` repository. From inside the cluster:

```bash
# Save the user/repo inputs into env vars for the heredoc
USER_ID="<uuid>"
REPO="<owner/repo>"
SHA="<optional-commit-sha-or-empty>"
IMAGE_URI=$(aws ssm get-parameter \
  --name "/k8s/${env}/job-images/tech-extractor" \
  --query 'Parameter.Value' --output text)

kubectl create -n tech-extractor -f - <<YAML
apiVersion: batch/v1
kind: Job
metadata:
  generateName: tech-extract-rerun-
  labels:
    app: tech-extractor
    rerun: "true"
spec:
  ttlSecondsAfterFinished: 3600
  backoffLimit: 0
  template:
    spec:
      restartPolicy: Never
      serviceAccountName: tech-extractor
      containers:
        - name: extractor
          image: "${IMAGE_URI}"
          env:
            - name: USER_ID
              value: "${USER_ID}"
            - name: REPO_FULL_NAME
              value: "${REPO}"
            - name: COMMIT_SHA
              value: "${SHA}"
          envFrom:
            - secretRef:
                name: tech-extractor-pg
            - secretRef:
                name: tech-extractor-github
YAML
```

The required env vars (`USER_ID`, `REPO_FULL_NAME`, `GITHUB_TOKEN`, the
five `PG_*` values) come from the two `secretRef`s in the spec
([applications/tech-extractor/src/env.ts:20-35](../../applications/tech-extractor/src/env.ts#L20-L35)).
The `tech-extractor-pg` and `tech-extractor-github` Secrets are
maintained by the sibling cluster-bootstrap repo's ExternalSecret
manifests; do not edit them inline.

### 4. Watch the Job to completion

```bash
JOB=$(kubectl -n tech-extractor get jobs -l rerun=true \
  --sort-by=.metadata.creationTimestamp -o name | tail -1)
kubectl -n tech-extractor logs "$JOB" -f
```

A successful Job emits `tech-extract.start` then a series of
extractor-level logs and finally `tech-extract.complete` with summary
counts. Pushgateway metrics
(`tech_extractor_layer1_recall{repo}=<value>`) are written before
exit.

### 5. Verify the new evidence

```bash
psql -h "$PG_HOST" -U "$PG_USER" -d "$PG_DATABASE" <<SQL
SELECT
  ontology_version,
  source_layer,
  COUNT(*) AS row_count,
  COUNT(DISTINCT technology_id) FILTER (WHERE technology_id IS NOT NULL) AS matched_canonicals
FROM technology_evidence
WHERE user_id = '${USER_ID}'
  AND repo_full_name = '${REPO}'
GROUP BY ontology_version, source_layer
ORDER BY ontology_version DESC, source_layer;
SQL
```

The newest `ontology_version` rows should be the rerun output. If
`matched_canonicals` for the new rows is materially higher than the
old rows, the rerun closed gaps — which is the point.

## Verification

- Job exit code is 0 (`kubectl get jobs … -o jsonpath='{.status.succeeded}'`
  returns `1`)
- `technology_parity_runs` has a row dated within the rerun window
- `technology_extractor_layer1_recall{repo="${REPO}"}` gauge in
  Prometheus reflects the rerun's recall (note: post-decommission the
  LLM-side of the parity comparison is always zero, so this gauge is
  not the most useful KPI — `matched_canonicals` per `source_layer` is)
- No `tech_extractor_extractor_failed_total{extractor=…}` counter
  increments occurred during the Job window

## Rollback

The rerun creates *new* rows; it does **not** delete the old ones.
There is no "undo" required — the previous extraction's rows remain
at their original `ontology_version` for audit. If you specifically
want to keep only one version of evidence per (user, repo) pair, that
is a downstream concern owned by whoever queries
`technology_evidence` (typically the
[projects clustering](../../applications/shared/src/projects/)) and
should be expressed as `WHERE ontology_version = (SELECT version FROM
ontology_version WHERE singleton = TRUE)`.

If the Job itself misbehaves (OOM, stuck, runaway), see
[docs/troubleshooting/tech-extractor-stuck-extraction.md](../troubleshooting/tech-extractor-stuck-extraction.md)
*(planned)* for diagnosis. Delete a stuck Job with:

```bash
kubectl -n tech-extractor delete "$JOB"
```

This terminates the pod; any partial Postgres writes already
committed remain (`insertMany` is one transaction per call, so a
mid-Job kill loses unwritten in-memory rows but does not corrupt the
table).

<!--
Evidence trail (auto-generated):
- Source: applications/tech-extractor/src/env.ts (read in full on 2026-05-27)
- Source: applications/tech-extractor/src/run-tech-extract.ts (lines 25-100 on 2026-05-27)
- Source: applications/tech-extractor/src/orchestrator/TechExtractOrchestrator.ts (lines 38-79 on 2026-05-27)
- Source: applications/shared/src/rds/implementations/TechnologyOntologyRepository.ts (lines 43-49 on 2026-05-27)
-->
