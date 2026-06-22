<!-- @format -->

# Session handoff — RAG ingestion incident, observability gaps, MCP/uv fix

**Date:** 2026-06-18
**Repo (primary):** `ai-applications`
**Cluster:** `k8s-eks-development` (eu-west-1, AWS profile `dev-account`)
**User under test:** `lamounier_88@hotmail.com` = userId `1d4c645a-447e-4b5b-924d-19a3c75a84db`

> Keep this file. It captures the full state so the work can resume even if the
> chat is lost. **Resume point is in the next section.**

---

## ⏭️ WHERE WE STOPPED — do these next

1. **Reconnect MCP servers / restart Codex + Claude Code** so the pinned MCP
   versions + CA bundle take effect (see *MCP / uv fix* below). Claude Code may
   re-prompt to approve `.mcp.json` — accept.
2. **Merge PR `ai-applications#264`** (MCP pinning chore) when ready.
3. **Execute the new repository build** — force-reindex the repos so they run on
   the **new ingestion image** (all 8 gap fixes + document_embeddings
   visibility + cost breakdown):
   - `tucaken-app` was already rebuilt successfully on the new image.
   - The other three (`ai-applications`, `kubernetes-bootstrap`, `tucaken-infra`)
     are `complete` but from the **older 12:xx incremental** sync — re-run a
     **Full rebuild (forceReindex)** on each to get full fileClass + the new logs.
4. **Watch the pod logs** for the new visibility lines (see *What the new logs
   show*). Confirm `document_embeddings build`, `document_embeddings written`,
   `ingestion.cost_breakdown`, real `job_name`, retrieval-probe progress.
5. Then **Regenerate** the project/case-study so it consumes the fuller evidence.

---

## ✅ Everything fixed this session (all live unless noted)

### A. The ingestion incident (repos stuck, UI blank) — RESOLVED
Three compounding root causes, all fixed:

| Cause | Fix | PR | State |
|------|-----|----|-------|
| Dispatch 403 — per-Job token Secret create denied (RBAC lacked `secrets`) | add `secrets: ["create"]` to `admin-api-job-creator` Role | `kubernetes-bootstrap#141` (→ **main**) | merged, **live** |
| Stuck `pending` never self-heals — `UPDATE repo_sync_state … updated_at` on a non-existent column threw in `reconcileStuckRepos` + `mark-timed-out` | drop the bogus `updated_at` writes | `tucaken-app#143` (→ main) | merged, live |
| One stuck repo blanked the **whole** connected-repos list (reconcile threw, unguarded → 500) | make reconcile best-effort (try/catch) at the call site | `tucaken-app#144` (→ main) | merged, live |

- `kubernetes-bootstrap#140` (→ develop) was the same RBAC change but **develop
  is not deployed** — the ArgoCD apps track **main**. The deploy came from #141.
- After the fixes, `tucaken-app` auto-healed `pending`→`error`, was
  force-reindexed clean: **704 files, 2493 chunks, quality 0.79,
  `full_reindex`, fileClass 100% classified** (source 1368, docs 703, test 316,
  history 58, config 26, ci 14, iac 5, script 3).

### B. Ingestion observability + cost gaps — `ai-applications#263` (→ **develop**, MERGED)
Eight fixes (from reviewing a real pod log):
1. **404 noise** — `ProfileInputCollector` now catches `RepoNotFoundError` by
   type (was string-matching `'returned 404'`, which never matched), so absent
   manifests (go.mod, Cargo.toml…) no longer log false "repo renamed/deleted".
2. **Run cost** — `ingestion.complete` now carries `cost_usd` +
   `bedrock_invocations` (SUM of `prompt_invocations` since run start);
   `deferred_enrichment.complete` carries `cost_usd`.
3. **Silent post-embed window** — retrieval probe now logs start/progress/score.
4. **Probe tunable** — `RETRIEVAL_PROBE_QUESTIONS` / `RETRIEVAL_PROBE_TOPK` env.
5. **Commit-cap truncation** — `listCommits` warns when the 500-cap drops history.
6. **Serial profile chain** — mirror/direction/reconciliation now run
   concurrently (independent), diagnostic last (~110s → slowest single call).
7. **JOB_NAME** consumer + (paired) `tucaken-app#146` injects it via downward API.
8. **document_embeddings visibility** — build-phase log (table, files visited,
   per-fileClass lanes, embedder=titan-embed, writer=RdsVectorStore), write-phase
   insert/update counts, and `ingestion.cost_breakdown` per-agent.

### C. JOB_NAME injection — `tucaken-app#146` (→ main, MERGED)
Job spec injects `JOB_NAME` from the pod's `job-name` label (downward API), so
`ingestion.complete` logs the real job name instead of `"unknown"`.

### D. MCP / uv disk-fill + EKS-MCP SSL break — see dedicated section below.

---

## 📦 Deployed images / how dispatch resolves them

- **ingestion image** (on-demand Job): admin-api reads tag from SSM
  `/k8s/development/job-images/ingestion` → ESO-synced into the
  `admin-api-job-images` secret (key `ingestion`) → admin-api 30s cache.
  **Current = `…/ingestion:83c030a0ae5da1bfb98e7f1b6372cc4ca9b0e76d-r1`** (the
  #263 develop merge — has all 8 gaps + visibility). `deploy-ingestion.yml`
  builds from **develop** and patches that SSM param.
- **admin-api image** (long-running, ArgoCD image-updater, NOT SSM):
  **running `admin-api:b3bf102042123124f191410e7064e4556023946a-r1`** (#146 JOB_NAME).

Verified live: SSM ingestion tag = new; `admin-api-job-images` secret key
`ingestion` = new tag; admin-api pod on b3bf102. **Next dispatch uses the new
ingestion image AND stamps real job_name.**

---

## 🔎 What the new logs show (next run)

```
[IngestionPipeline] <repo>: document_embeddings build — <N> files visited,
  <M> chunks (<to-embed> to embed, <unchanged> unchanged);
  lanes source=… docs=… test=… iac=… ; embedder=titan-embed
  writer=RdsVectorStore.upsertBatch table=document_embeddings
[IngestionPipeline] <repo>: document_embeddings written — inserted … updated … skipped … errors …
{ "event":"ingestion.cost_breakdown", "total_usd":…, "by_agent":[
   {"agent":"titan-embed","model":"amazon.titan-embed-text-v2:0",…},   // builds document_embeddings
   {"agent":"chunk-enrich",…}, {"agent":"profile-extract",…}, {"agent":"retrieval-probe",…},
   {"agent":"profile-mirror|direction|reconciliation|diagnostic",…} ] }
{ "event":"ingestion.complete", …, "cost_usd":…, "bedrock_invocations":…, "job_name":"ingestion-…" }
[RetrievalProbe] <repo>: generating N probe questions… / score=0.xx (recall@3=… mrr=…)
```

**Agents in a run (and what they touch):**
- `profile-extract` (Haiku) → `repository_profile_embeddings` + classification.
- chunk + embed (deterministic) → **`document_embeddings`** = the RAG KB.
- `chunk-enrich` (Haiku) → `document_embeddings.skills` (hybrid retrieval).
- `retrieval-probe` (Haiku) → reads KB, writes `repo_sync_state.retrieval_score`.
- `profile-mirror/direction/reconciliation/diagnostic` → `user_profile_rollup`.
- **None of the named agents create the KB chunks** — the deterministic
  chunk+Titan-embed pass does; `chunk-enrich` is the only LLM call that shapes
  retrieval content (skills).

---

## 🛠️ How to verify / useful commands

**Cluster (EKS MCP preferred once reconnected; kubectl fallback):**
```
aws eks update-kubeconfig --name k8s-eks-development --region eu-west-1 --profile dev-account
kubectl get pods -n ingestion                 # watch the dispatched Job pod
kubectl get pods -n admin-api -o jsonpath='{.items[*].spec.containers[0].image}'
kubectl logs -n ingestion <ingestion-pod>     # the new visibility lines
```

**DB (read) — SSM tunnel + psql (smoke_sql/pgbouncer tunnel was flaky):**
```
cd ~/Desktop/portfolio/tucaken-app
just _rds-query "SELECT repo_full_name, sync_status, last_sync_type, last_synced_at FROM repo_sync_state WHERE user_id='1d4c645a-447e-4b5b-924d-19a3c75a84db' ORDER BY repo_full_name;"
# fileClass lanes for a repo:
just _rds-query "SELECT COALESCE(metadata->>'fileClass','(none)') lane, COUNT(*) FROM document_embeddings WHERE user_id='1d4c645a-447e-4b5b-924d-19a3c75a84db' AND repo_full_name='<owner/repo>' GROUP BY 1 ORDER BY 2 DESC;"
# per-agent cost for a run:
just _rds-query "SELECT agent, model_id, COUNT(*), SUM(total_cost_cents) FROM prompt_invocations WHERE user_id='1d4c645a-447e-4b5b-924d-19a3c75a84db' AND repo_name='<owner/repo>' GROUP BY 1,2 ORDER BY 4 DESC;"
```

**SSM image tags:**
```
aws ssm get-parameter --name /k8s/development/job-images/ingestion --query Parameter.Value --output text --profile dev-account --region eu-west-1
```

---

## 🧩 MCP / uv fix (disk-fill + EKS-MCP SSL break)

**Cause:** uvx MCPs pinned to `@latest` re-resolve every launch; uv's
append-only `~/.cache/uv` accumulated stale dep trees (botocore, CFN, sympy,
networkx) → disk full → Mac crashed. A cache prune deleted the running EKS MCP's
certifi → `SSL validation failed … No such file or directory`.

**Fixes:**
- **Pinned versions** (no `@latest`):
  - `ai-applications/.mcp.json` → eks `0.1.32`, cloudwatch `0.1.4`, aws-api `1.3.44` (PR **#264**, committed).
  - `~/.codex/config.toml` → blender `1.6.4`, grafana `0.15.2`.
  - Codex plugin caches (`.bak` backups kept) → aws-iac `1.0.19`, aws-pricing `1.0.31`, aurora-dsql `1.0.32`.
- **CA bundle pinned** to `/etc/ssl/cert.pem` (`AWS_CA_BUNDLE`/`SSL_CERT_FILE`/`REQUESTS_CA_BUNDLE`) on the AWS MCPs → SSL survives cache churn.
- **Weekly prune** LaunchAgent `com.nelson.uv-cache-prune`
  (`~/Library/LaunchAgents/com.nelson.uv-cache-prune.plist`, Sun 03:00, log
  `~/Library/Logs/uv-cache-prune.log`). Immediate run freed 5.6 GiB (cache 13G→6.1G).
- Left `~/.claude.json` grafana/blender unpinned (not `@latest`, low churn,
  large/stateful file — prune covers them).
- **To update a pinned MCP later:** bump the explicit version; never revert to
  `@latest`. Plugin updates may reset plugin-cache pins (re-run the pin; `.bak`s exist).
- uv path: `/opt/anaconda3/bin/uv`. **Reconnect/restart needed** for pins to load.

---

## 📋 Open / follow-ups

- **PR `ai-applications#264`** (MCP pinning) — open, merge when ready.
- **tech-extractor dispatch still injects `GITHUB_TOKEN` as plaintext env**
  (`tucaken-app` `routes/github.ts` ~line 611) — the secretRef hardening only
  reached the ingestion path. Separate follow-up if parity wanted.
- **`profile-extract` is on the critical path** (`run-ingestion.ts:~513`
  rethrows) — a profile-extract failure aborts the whole run incl. the
  deterministic KB build that doesn't need it. Consider making it best-effort
  like the probe/synth agents (potential 9th gap).
- **Pre-existing lint debt** in `applications/` (complexity:10 not CI-enforced):
  `main` in run-ingestion (27), `listPullRequests` (14), the rollup span arrow
  (17) — untouched by #263, tracked separately.
- Other 3 repos still need a **Full rebuild** to refresh fileClass on the new image.

---

## Branch state (ai-applications)
- Default base: `develop`. Currently on `chore/pin-mcp-versions-ca-bundle` (PR #264).
- There is **unrelated uncommitted RAG WIP** in the working tree (ChunkerRegistry,
  FileFilter, CodeChunker*, evidence-topology, PgVectorRetriever, deleted
  rag-checklist/docs, package.json, yarn.lock) — NOT part of this session's work;
  left untouched.
