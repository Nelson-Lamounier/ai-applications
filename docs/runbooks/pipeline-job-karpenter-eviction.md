# Pipeline Jobs Disrupted by Karpenter — Troubleshooting Guide

How to diagnose a **dispatched pipeline Job** (coach, strategist, ingestion, tech-extractor — anything built by `admin-api/src/lib/k8s-job-builder.ts`) that runs for several minutes, shows **`Complete`**, yet **writes no result to the database** and leaves the UI spinning forever.

The trap: the Job looks successful (`succeeded=1`), so you chase a persistence/grounding/RLS bug — when the real cause is the **node autoscaler killing the pod mid-run**.

## Background

These pipelines run as one-shot Kubernetes `Job`s in the `job-strategist` namespace, each making a multi-minute Bedrock call (Sonnet coach ≈ 3 min). The cluster uses **Karpenter** for node autoscaling. Karpenter's *consolidation* (a.k.a. *disruption*) feature reclaims **underutilized** nodes by evicting their pods and rescheduling them elsewhere — cheaper nodes, fewer nodes. That is fine for stateless replicas behind a Deployment, but **fatal for a long-running batch Job** that must run to completion to persist its result. Unless a pod opts out, Karpenter will evict it the moment its node looks underutilized.

---

## Issue 1: Coach prep never appears — Job `Complete` but `coaching_content` not written

### Symptom

- UI action **"System Design prep — Generate tailored prep when you reach this stage"** spins and never produces prep.
- The coach Job reports success:
  ```
  coach-<appId>-system--xxxx   Complete   1/1   2m59s
  ```
- But no row exists for that stage. Verbatim, the diagnostic query returns empty:
  ```
  SELECT ... FROM coaching_content
  WHERE job_application_id='<appId>' AND stage_type='system-design'
  -- → 0 rows
  ```
- Pod logs **stop ~6 s in** (last line `Starting agent execution — model=…-sonnet-4-6, … messageLength=… chars`) and never reach `coach_pipeline_complete`.
- Pod events contain, verbatim:
  ```
  Normal  Evicted   Evicted pod: Underutilized
  Normal  Killing   Stopping container pipeline
  ```

### Root Cause

**Karpenter consolidation evicts the running pipeline pod mid-Bedrock-call.** The Job pod template in `k8s-job-builder.ts` carries **no `karpenter.sh/do-not-disrupt` annotation**, so Karpenter treats it as freely movable. While the coach is ~3 minutes into its Sonnet call, Karpenter decides the node is `Underutilized`, **evicts** the pod, and kills the container before it reaches the persist step. The work (and the Bedrock spend) is lost; nothing is written to `coaching_content`.

The failure is **silent** because the Job still ends up `Complete` (`succeeded=1`) — a pod exits non-erroring on the eviction/SIGTERM path before persisting — so nothing looks broken until you check the database.

This is **not** an RLS-visibility issue (you can see the app's older `coaching_content` rows just fine) and **not** a schema/migration regression (the persist code is unchanged and worked when the pod was left alone).

### Fix

Opt the pipeline pods out of Karpenter disruption. In `tucaken-app/admin-api/src/lib/k8s-job-builder.ts`, add the annotation to the **pod template** metadata:

```ts
// before
template: {
    metadata: { labels: sanitisedLabels },
    spec: { restartPolicy: 'Never', /* … */ },
},

// after
template: {
    metadata: {
        labels: sanitisedLabels,
        annotations: { 'karpenter.sh/do-not-disrupt': 'true' },
    },
    spec: { restartPolicy: 'Never', /* … */ },
},
```

`karpenter.sh/do-not-disrupt: "true"` tells Karpenter never to voluntarily evict the pod for consolidation/drift while it is running. Because the Job sets `restartPolicy: Never` + `ttlSecondsAfterFinished: 3600`, the pod disappears shortly after completion, so the opt-out does **not** pin a node open indefinitely — only for the few minutes the pipeline actually runs. This builder is shared by every dispatched pipeline, so one change protects coach, strategist, ingestion, and tech-extractor Jobs alike.

> Secondary hardening (optional): make the pipeline **fail** (non-zero exit) when interrupted before its persist step, so an evicted run shows as a failed Job instead of a misleading `Complete`. The primary fix above prevents the eviction in the first place.

### Diagnose

Run these in order; each rules out a layer.

**1 — Is the result actually missing from the DB?** (ground truth, not the UI)
```sql
SELECT (topics_to_study ? 'systemDesignWalkthrough') AS has_walkthrough,
       jsonb_array_length(COALESCE(topics_to_study->'systemDesignWalkthrough','[]'::jsonb)) AS cards
FROM coaching_content
WHERE job_application_id='<appId>' AND stage_type='system-design';
```
Empty → the prep was never persisted. (Via the tucaken-smoke MCP: `smoke_sql`.)

**2 — Is it RLS hiding the row, or genuinely absent?** Check whether *other* stages of the same app are visible:
```sql
SELECT stage_type, generated_at FROM coaching_content
WHERE job_application_id='<appId>' ORDER BY generated_at DESC;
```
If older stages (`technical`, `phone-screen`) show up but today's run doesn't, it's **not** RLS — the row was never written.

**3 — Did the Job "succeed"?** (the misleading part)
```bash
kubectl get job -n job-strategist -o jsonpath='{range .items[*]}{.metadata.name}{"  succeeded="}{.status.succeeded}{" failed="}{.status.failed}{"\n"}{end}' | grep '<appId>.*system'
```
`succeeded=1` despite no data → suspect an interrupted run, not a logic bug.

**4 — Where did the logs stop?** Pods are GC'd after `ttlSecondsAfterFinished`, so pull from Loki, not kubectl:
```
# Grafana MCP: query_loki_logs, datasourceUid="loki"
{pod="coach-<appId>-system--xxxx"}     # direction=backward, limit ~20
```
Only 2–3 lines, ending at `Starting agent execution` → the process was killed mid-run.

**5 — Why did it stop?** The decisive command — pod events:
```bash
kubectl get events -n job-strategist --sort-by=.lastTimestamp | grep -iE 'Evicted|Underutilized|Nominated|Killing'
```
`Evicted pod: Underutilized` + repeated `Nominated → Evicted` = Karpenter consolidation.

**6 — Confirm the pods aren't opted out:**
```bash
kubectl get job -n job-strategist <jobName> -o jsonpath='{.spec.template.metadata.annotations}'
```
Empty `{}` (no `karpenter.sh/do-not-disrupt`) confirms the root cause.

#### Command flag reference

| Command / flag | What it does |
|---|---|
| `kubectl get events --sort-by=.lastTimestamp` | events oldest→newest; the eviction story reads in order |
| `-o jsonpath='{.spec.template.metadata.annotations}'` | print just the pod-template annotations (where `do-not-disrupt` would live) |
| `{.status.succeeded}` / `{.status.failed}` | Job completion counters — `succeeded=1` with no data is the tell |
| Loki `{pod="…"}` + `direction=backward` | newest-first log lines; see where output stops |
| `karpenter.sh/do-not-disrupt: "true"` | pod annotation; Karpenter won't voluntarily evict it for consolidation/drift |

### Verify

After deploying the fix, re-trigger the prep and watch the pod live:
```bash
kubectl get pods -n job-strategist -w | grep '<appId>.*system'
# in another shell, while it runs:
kubectl get events -n job-strategist --sort-by=.lastTimestamp | grep -iE 'Evicted|Underutilized' | tail
```
Then confirm persistence:
```sql
SELECT jsonb_array_length(topics_to_study->'systemDesignWalkthrough') AS cards
FROM coaching_content WHERE job_application_id='<appId>' AND stage_type='system-design';
```

### What Success Looks Like

- **No** `Evicted: Underutilized` event for the coach pod during its run.
- Pod runs uninterrupted to `Succeeded`; Loki shows the full log through `coach_pipeline_complete`.
- `coaching_content` has a `system-design` row with `cards > 0` (e.g. 10), and the UI renders the walkthrough.

---

## Glossary

- **Karpenter** — Kubernetes node autoscaler. Provisions nodes for pending pods and *consolidates* (removes/replaces) underutilized nodes to cut cost.
- **Consolidation / Disruption** — Karpenter reclaiming a node by evicting its pods and rescheduling them. Voluntary; respects `karpenter.sh/do-not-disrupt`.
- **`Evicted: Underutilized`** — the event Karpenter emits when it drains a pod off a node it has judged underutilized.
- **`karpenter.sh/do-not-disrupt`** — pod (or node) annotation set to `"true"` to forbid Karpenter from voluntarily evicting it. The standard guard for uninterruptible batch Jobs.
- **`Nominated`** — scheduler/Karpenter event indicating the pod has been assigned a target node/nodeclaim to (re)schedule onto — here, repeatedly, as it was bounced between nodes.
- **`ttlSecondsAfterFinished`** — Job field; auto-deletes the Job (and its pod) N seconds after it finishes. Why pod logs vanish from `kubectl` and must be read from Loki.
- **`coaching_content`** — the table holding generated interview prep, keyed by `(job_application_id, stage_type)`. `topics_to_study.systemDesignWalkthrough` holds the System Design cards.
- **pipeline Job** — a one-shot `batch/v1` Job built by `admin-api/src/lib/k8s-job-builder.ts` to run a Bedrock pipeline (coach, strategist, ingestion, …) in `job-strategist`.
