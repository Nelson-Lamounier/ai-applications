---
title: Tech-extractor Job hung or failing
type: troubleshooting
tags: [tech-extractor, kubernetes, github, postgres, tarball]
sources:
  - applications/tech-extractor/src/run-tech-extract.ts
  - applications/tech-extractor/src/tarball/fetchTarball.ts
  - applications/tech-extractor/src/tarball/safeExtract.ts
  - applications/tech-extractor/src/orchestrator/TechExtractOrchestrator.ts
created: 2026-05-27
updated: 2026-05-27
---

## Symptom

One or more of:

- K8s Job for tech-extractor stays `Active` past its normal runtime
  (typical Job ≈ 30 s – 3 min depending on repo size)
- Job exits non-zero with `tarball fetch failed: HTTP <n>` or
  `repo_too_large`
- Pod logs show `teardown timed out` and the pod takes its termination
  grace period to exit
- `tech_extractor_extractor_failed_total{extractor="iac"|"treesitter"|"syft"}`
  counter increments without a clear correlated repo
- `technology_evidence` rows for an expected user/repo are missing
  entirely
- Job exits successfully but matched count is suspiciously low (e.g. zero)

## Root cause

Five distinct failure modes share the surface symptoms:

1. **Tarball oversize** — repo exceeds `MAX_TARBALL_BYTES`
   (default 200 MB,
   [applications/tech-extractor/src/run-tech-extract.ts:33](../../applications/tech-extractor/src/run-tech-extract.ts#L33)).
   `fetchTarball` throws after reading the Content-Length header
   ([applications/tech-extractor/src/tarball/fetchTarball.ts:10-30](../../applications/tech-extractor/src/tarball/fetchTarball.ts#L10-L30)).
2. **GitHub API failure** — non-2xx from the archive endpoint (rate
   limit, missing token scope, repo deleted/renamed, branch protection
   blocking archive). Throws `tarball fetch failed: HTTP <status>`
   ([fetchTarball.ts:29](../../applications/tech-extractor/src/tarball/fetchTarball.ts#L29)).
3. **Malicious tarball rejected by safeExtract** — symlink, hardlink,
   absolute path, or `..` traversal in archive entries. `safeFilter`
   drops the entry silently
   ([applications/tech-extractor/src/tarball/safeExtract.ts:7-15](../../applications/tech-extractor/src/tarball/safeExtract.ts#L7-L15));
   the Job still completes but fewer files reach the walker. A
   genuinely-hostile tarball exceeding `maxEntries = 50_000` aborts
   `safeExtract` with the tar library's own error.
4. **Single extractor crash** — `Promise.allSettled` isolates the
   failure
   ([TechExtractOrchestrator.ts:41-50](../../applications/tech-extractor/src/orchestrator/TechExtractOrchestrator.ts#L41-L50));
   the Job completes successfully but with a `failedExtractors[]`
   array recorded. The counter
   `tech_extractor_extractor_failed_total{extractor=…}` is incremented
   on this path.
5. **Postgres unavailable** — every error other than the above is
   typically a `pg` connection failure (max=3 pool exhausted, network
   timeout, RDS reboot/maintenance). Throws from `evidenceRepo.insertMany`
   or `candidateRepo.upsert` and aborts the Job.

## How to diagnose

### 1. Find the Job

```bash
JOB=$(kubectl -n tech-extractor get pods \
  -l app=tech-extractor \
  --sort-by=.metadata.creationTimestamp \
  -o jsonpath='{.items[-1:].metadata.name}')

kubectl -n tech-extractor describe pod "$JOB" | grep -E 'State|Reason|Last|Restart'
```

`State: Running` past 5 min on a public repo = stuck (mechanism 4 or 5).
`State: Failed` with `Reason: OOMKilled` = the orchestrator's accumulated
`evidence[]` array exceeded the pod memory limit on a huge repo.

### 2. Read the structured logs

```bash
kubectl -n tech-extractor logs "$JOB" | tail -200 | jq -c .
```

Mechanism-specific markers to grep for:

| Grep pattern | Mechanism |
| :- | :- |
| `"tarball fetch failed: HTTP"` | (2) GitHub API |
| `"repo_too_large"` | (1) Oversize |
| `"teardown timed out"` | Stuck unlink on Job exit (rare; cosmetic) |
| `"extract"` + `"rejected"` | (3) safeExtract entry rejection |
| `failedExtractors":["iac"]` or `["treesitter"]` or `["syft"]` | (4) Single extractor crash |
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
the 200 MB cap. If the cap is the issue, raise `MAX_TARBALL_BYTES`
via the K8s Job env block in the cluster repo, not by editing the
extractor.

### 5. For an iac extractor crash, find the offending file

```bash
kubectl -n tech-extractor logs "$JOB" | \
  jq -c 'select(.message | startswith("iac")) | {file, error}' | \
  head -20
```

The iacExtractor reads files sequentially inside its `extract()`
([applications/tech-extractor/src/run-tech-extract.ts:53-100](../../applications/tech-extractor/src/run-tech-extract.ts#L53-L100));
the last file processed before the crash is usually the malformed one.

## How to fix

### Mechanism 1 — oversize repo

If the repo is legitimately large (monorepo, vendored binaries, ML
weights): raise `MAX_TARBALL_BYTES` for that user's Job spec only,
ideally not globally. The cap exists as a runaway-protection, not as
a policy ceiling.

```bash
# Re-run with a higher cap via the rerun runbook:
# Add to the Job env block:
#   - name: MAX_TARBALL_BYTES
#     value: "524288000"   # 500 MB
```

See [docs/runbooks/tech-extractor-rerun.md](../runbooks/tech-extractor-rerun.md).

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

`tech_extractor_extractor_failed_total{extractor="iac"}` increments
do not block a Job — but they do mean evidence is missing from that
extractor for that run. Steps:

1. Identify the offending file (diagnosis step 5).
2. Add a regression test for that file's shape in the parser's
   `__tests__/` directory.
3. Fix the parser to handle it (or to reject it gracefully). The
   parsers that crash most often are the YAML-based ones
   (`K8sManifestParser`, `ArgoHelmParser`) on malformed multi-doc
   files; the parsing library `yaml` is strict by default.

### Mechanism 5 — Postgres

- Verify `pg.max=3` (set in
  [run-tech-extract.ts](../../applications/tech-extractor/src/run-tech-extract.ts))
  is consistent with the RDS instance `max_connections`. The platform
  runs a single provisioned RDS PostgreSQL instance
  (`k8s-dev-platform-rds`), so the connection ceiling is fixed by the
  instance class — sum the `pg.max` of every concurrent Job against it.
- Check RDS instance health
  (`aws rds describe-db-instances --db-instance-identifier k8s-dev-platform-rds`).
- A Postgres timeout during `insertMany` aborts the Job
  mid-flush — the candidates and matched evidence already inserted
  *do* commit (one transaction per `insertMany` call,
  [TechExtractOrchestrator.ts:75](../../applications/tech-extractor/src/orchestrator/TechExtractOrchestrator.ts#L75)),
  so a retry produces duplicate evidence rows for the in-flight repo.
  Clean up duplicates by `ontology_version + commit_sha + file_path +
  line_start` if needed.

## How to prevent

- **Right-size pod memory.** A repo with thousands of files produces
  thousands of `evidence[]` entries held in memory before
  `insertMany`. The pod's memory `limits` in the K8s Job spec should
  account for ~1 KB per row × expected max rows for the largest
  legitimate repo plus the tarball-fetch + extract surface.
- **Per-extractor circuit-breakers.** Mechanism 4 (single extractor
  crash) is logged but the Job completes. If `iac` crashes on every
  Job for a given user/repo, the *current evidence will silently
  regress* until the parser is fixed. Alert on a sustained
  non-zero `tech_extractor_extractor_failed_total{extractor=…}` rate
  per user — not just on Job failures.
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
- Source: applications/tech-extractor/src/run-tech-extract.ts (read on 2026-05-27)
- Source: applications/tech-extractor/src/tarball/fetchTarball.ts (lines 1-30 on 2026-05-27)
- Source: applications/tech-extractor/src/tarball/safeExtract.ts (lines 1-30 on 2026-05-27)
- Source: applications/tech-extractor/src/orchestrator/TechExtractOrchestrator.ts (lines 38-79 on 2026-05-27)
-->
