---
title: Ingestion Job's facts stage hung or failing
type: troubleshooting
tags: [tech-extractor, ingestion, kubernetes, github, postgres, tarball]
sources:
  - applications/ingestion/src/run-ingestion.ts
  - applications/ingestion/src/acquisition/tarball/fetchTarball.ts
  - applications/ingestion/src/acquisition/tarball/safeExtract.ts
  - applications/ingestion/src/facts/TechExtractOrchestrator.ts
created: 2026-05-27
updated: 2026-07-18
---

> **Now runs inside unified ingestion (2026-07-18).** The standalone
> `tech-extractor` Job this doc originally targeted has been retired.
> Every failure mode below (tarball fetch, safe-extract, extractor
> crash, Postgres) still exists — the code that produces it just moved
> into the `ingestion` Job's facts stage
> (`applications/ingestion/src/facts/`, entry point `runFactsStage`),
> which now shares the `ingestion` Job's pod, namespace, and log stream
> instead of running in a sibling Job. See
> [docs/projects/tech-extractor.md](../projects/tech-extractor.md) for
> the retirement note.

## Symptom

One or more of:

- K8s Job `ingestion-*` in the `ingestion` namespace stays `Active`
  past its normal runtime (the pod's `activeDeadlineSeconds` is
  currently 1800s / 30 min — see
  `applications/ingestion/src/run-ingestion.ts`'s deadline plumbing)
- Job exits non-zero with `tarball fetch failed: HTTP <n>` or
  `repo_too_large`
- Pod logs show `teardown step timed out — continuing to exit` near
  Job exit (bounded to a few seconds per step — see below; this is a
  different mechanism from a stuck tarball unlink)
- The `unified_facts.complete` log line has a non-empty
  `failedExtractors` array without a clear correlated repo
- `technology_evidence` rows for an expected user/repo are missing
  entirely
- Job exits successfully but matched count is suspiciously low (e.g. zero)

## Root cause

Five distinct failure modes share the surface symptoms:

1. **Tarball oversize** — repo exceeds `MAX_TARBALL_BYTES`
   (default 200 MB,
   [applications/ingestion/src/run-ingestion.ts:688](../../applications/ingestion/src/run-ingestion.ts#L688)).
   `fetchTarball` throws after reading the Content-Length header, or
   after the streamed byte count exceeds the cap
   ([applications/ingestion/src/acquisition/tarball/fetchTarball.ts:58](../../applications/ingestion/src/acquisition/tarball/fetchTarball.ts#L58),
   [:71](../../applications/ingestion/src/acquisition/tarball/fetchTarball.ts#L71)).
2. **GitHub API failure** — non-2xx from the archive endpoint (rate
   limit, missing token scope, repo deleted/renamed, branch protection
   blocking archive). Throws `tarball fetch failed: HTTP <status>`
   ([fetchTarball.ts:55](../../applications/ingestion/src/acquisition/tarball/fetchTarball.ts#L55)).
3. **Malicious tarball rejected by safeExtract** — symlink, hardlink,
   absolute path, or `..` traversal in archive entries. `safeFilter`
   drops the entry silently
   ([applications/ingestion/src/acquisition/tarball/safeExtract.ts:11-16](../../applications/ingestion/src/acquisition/tarball/safeExtract.ts#L11-L16));
   the Job still completes but fewer files reach the walker. A
   genuinely-hostile tarball exceeding `maxEntries = 50_000` aborts
   `safeExtract` with the tar library's own error.
4. **Single extractor crash** — `Promise.allSettled` isolates the
   failure
   ([TechExtractOrchestrator.ts:78-101](../../applications/ingestion/src/facts/TechExtractOrchestrator.ts#L78-L101));
   the Job completes successfully but with a `failedExtractors[]`
   array recorded on the `unified_facts.complete` log line
   ([applications/ingestion/src/run-ingestion.ts:861-867](../../applications/ingestion/src/run-ingestion.ts#L861-L867)).
   There is no longer a dedicated Prometheus counter for this — the
   standalone Job's `tech_extractor_extractor_failed_total` metric was
   retired with it; grep logs instead (see below).
5. **Postgres unavailable** — every error other than the above is
   typically a `pg` connection failure (pool exhausted, network
   timeout, RDS reboot/maintenance). Throws from `evidenceRepo.insertMany`
   or `candidateRepo.upsert` and aborts the Job. The pool is sized to
   `max: 16`
   ([applications/ingestion/src/run-ingestion.ts:1006](../../applications/ingestion/src/run-ingestion.ts#L1006)) —
   raised from an earlier `max: 3` after a live incident where the
   deferred-enrichment worker fan-out (up to 10 concurrent workers)
   starved the pool and silently dropped ~46% of a 2,511-chunk
   force-reindex (see the code comment at that line for the postmortem
   numbers).

## How to diagnose

### 1. Find the Job

```bash
JOB=$(kubectl -n ingestion get pods \
  -l app=ingestion-worker \
  --sort-by=.metadata.creationTimestamp \
  -o jsonpath='{.items[-1:].metadata.name}')

kubectl -n ingestion describe pod "$JOB" | grep -E 'State|Reason|Last|Restart'
```

`State: Running` past the pod's `activeDeadlineSeconds` on a public
repo = stuck (mechanism 4 or 5, or a hang in a later ingestion stage
— the facts stage is only part of the Job). `State: Failed` with
`Reason: OOMKilled` = the orchestrator's accumulated `evidence[]`
array (or the rest of the ingestion pipeline) exceeded the pod's
2 Gi memory limit on a huge repo.

### 2. Read the structured logs

```bash
kubectl -n ingestion logs "$JOB" | tail -200 | jq -c .
```

Mechanism-specific markers to grep for:

| Grep pattern | Mechanism |
| :- | :- |
| `"tarball fetch failed: HTTP"` | (2) GitHub API |
| `"repo_too_large"` | (1) Oversize |
| `"unified_on.tarball_failed"` (or `unified_shadow.tarball_failed`) | (1)/(2) tarball fetch/extract failed — facts stage skipped, rest of ingestion continues degraded |
| `failedExtractors":["iac"]` or `["treesitter"]` or `["syft"]` on `unified_facts.complete` | (4) Single extractor crash |
| `"connect ECONNREFUSED"` / `"timeout expired"` | (5) Postgres |

### 3. Confirm GitHub-side state

For mechanism 2:

```bash
# Token scope (needs 'public_repo' minimum, 'repo' for private):
curl -sI -H "Authorization: Bearer ${GITHUB_TOKEN}" https://api.github.com/user \
  | grep -i 'x-oauth-scopes'

# Repo accessible at all:
curl -sI -H "Authorization: Bearer ${GITHUB_TOKEN}" \
  https://api.github.com/repos/${REPO_FULL_NAME} \
  | head -3

# Tarball endpoint specifically:
curl -sI -L -H "Authorization: Bearer ${GITHUB_TOKEN}" \
  "https://api.github.com/repos/${REPO_FULL_NAME}/tarball/HEAD" \
  | head -5
```

A `429` is a rate-limit; check `X-RateLimit-Remaining` /
`X-RateLimit-Reset` headers. A `404` after the token is good usually
means the repo was renamed or deleted.

### 4. Confirm repo size

For mechanism 1:

```bash
# GitHub reports size in KB
curl -s -H "Authorization: Bearer ${GITHUB_TOKEN}" \
  "https://api.github.com/repos/${REPO_FULL_NAME}" | jq -r '.size' \
  | awk '{print $1 " KB ≈ " $1/1024 " MB (uncompressed)"}'
```

The tarball is *compressed*, so a 250 MB repo may still fit inside
the 200 MB cap. If the cap is the issue, raise `MAX_TARBALL_BYTES` on
the ingestion Job spec (`tucaken-app`'s admin-api
`buildIngestionJobSpec`), not by editing the extractor.

### 5. For an iac extractor crash, find the offending file

```bash
kubectl -n ingestion logs "$JOB" | \
  jq -c 'select(.message | startswith("iac")) | {file, error}' | \
  head -20
```

The `iacExtractor` reads files sequentially inside its `extract()`
closure
([applications/ingestion/src/facts/run-facts-stage.ts:169-180](../../applications/ingestion/src/facts/run-facts-stage.ts#L169-L180));
the last file processed before the crash is usually the malformed one.

## How to fix

### Mechanism 1 — oversize repo

If the repo is legitimately large (monorepo, vendored binaries, ML
weights): raise `MAX_TARBALL_BYTES` for that user's Job spec only,
ideally not globally. The cap exists as a runaway-protection, not as
a policy ceiling. There is no per-Job override surfaced through the
admin-trigger route today — raising it means changing the
`MAX_TARBALL_BYTES` env default in `buildIngestionJobSpec`
(`tucaken-app`'s admin-api) or setting the deployment-level env var,
then re-running via
[docs/runbooks/tech-extractor-rerun.md](../runbooks/tech-extractor-rerun.md).

If the repo is bloated by accident (committed `node_modules`, large
generated artefacts), no extractor fix is appropriate; flag the repo
owner.

### Mechanism 2 — GitHub API

- `429` → wait for `X-RateLimit-Reset`; if persistent, the
  `GITHUB_TOKEN` Secret is shared too widely or the rate-limit budget
  per Job is too small.
- `404` → confirm the user's connected repo identifier is current; a
  rename without a webhook update leaves the platform pointed at the
  old path.
- `403` with `not accessible by integration` → GitHub App
  installation is missing the repo. Re-install via the user's
  account settings; do not re-issue the App's PAT.

### Mechanism 3 — malicious / weird tarball

`safeFilter` correctly drops the suspicious entries — the Job
continues with what's left. Investigate the source repo (`git
log -- 'suspicious-path'`) only if the dropped entries explain a
recall regression. The `maxEntries = 50_000` cap is a true
zip-bomb defence; raising it is rarely the right fix.

### Mechanism 4 — single extractor crash

A `failedExtractors` entry on `unified_facts.complete` does not block
the Job — but it does mean evidence is missing from that extractor for
that run. Steps:

1. Identify the offending file (diagnosis step 5).
2. Add a regression test for that file's shape in the parser's
   `__tests__/` directory
   (`applications/ingestion/src/facts/extractors/`).
3. Fix the parser to handle it (or to reject it gracefully). The
   parsers that crash most often are the YAML-based ones
   (`K8sManifestParser`, `ArgoHelmParser`) on malformed multi-doc
   files; the parsing library `yaml` is strict by default.

### Mechanism 5 — Postgres

- Verify `pg.max` (currently `16`, set in
  [run-ingestion.ts:1006](../../applications/ingestion/src/run-ingestion.ts#L1006))
  is consistent with the RDS instance `max_connections`. The platform
  runs a single provisioned RDS PostgreSQL instance
  (`k8s-dev-platform-rds`), so the connection ceiling is fixed by the
  instance class — sum the `pg.max` of every concurrent Job against it.
- Check RDS instance health
  (`aws rds describe-db-instances --db-instance-identifier k8s-dev-platform-rds`).
- A Postgres timeout during `insertMany` aborts the Job
  mid-flush — the candidates and matched evidence already inserted
  *do* commit (one transaction per `insertMany` call,
  [TechExtractOrchestrator.ts:105](../../applications/ingestion/src/facts/TechExtractOrchestrator.ts#L105)),
  so a retry produces duplicate evidence rows for the in-flight repo.
  Clean up duplicates by `extracted_at_ontology_version + commit_sha +
  file_path + line_start` if needed.

## How to prevent

- **Right-size pod memory.** A repo with thousands of files produces
  thousands of `evidence[]` entries held in memory before
  `insertMany`, on top of the rest of the ingestion pipeline's own
  memory use in the same pod. The Job's memory `limits` (currently
  2 Gi, raised for the unified-ingestion cutover — see
  `buildIngestionJobSpec`) should account for ~1 KB per evidence row ×
  expected max rows for the largest legitimate repo plus the
  tarball-fetch + extract + chunking surface.
- **Per-extractor visibility.** Mechanism 4 (single extractor crash)
  is logged but the Job completes. If `iac` crashes on every Job for a
  given user/repo, the *current evidence will silently regress* until
  the parser is fixed. Without a Prometheus counter any more, this
  means a Loki alert on `event: "unified_facts.complete"` with a
  non-empty `failedExtractors` field is the closest equivalent —
  there is no out-of-the-box alert wired up for this today.
- **GitHub App vs PAT.** A shared PAT shares rate limits; a per-user
  GitHub App installation has its own rate budget. Mechanism 2
  rate-limit storms typically indicate the wrong auth model for
  high-volume extraction.
- **Tarball cap with headroom.** Set `MAX_TARBALL_BYTES` at ~2× the
  largest legitimate repo you intend to support. The cap exists so a
  runaway repo cannot eat the Job pod's disk; it should not be tight
  enough that one legitimate user's monorepo trips it.

<!--
Evidence trail (auto-generated):
- Source: applications/ingestion/src/run-ingestion.ts (lines 680-1010, 855-870 on 2026-07-18)
- Source: applications/ingestion/src/acquisition/tarball/fetchTarball.ts (read on 2026-07-18)
- Source: applications/ingestion/src/acquisition/tarball/safeExtract.ts (read on 2026-07-18)
- Source: applications/ingestion/src/facts/TechExtractOrchestrator.ts (read on 2026-07-18)
- Source: applications/ingestion/src/facts/run-facts-stage.ts (lines 130-230 on 2026-07-18)
-->
