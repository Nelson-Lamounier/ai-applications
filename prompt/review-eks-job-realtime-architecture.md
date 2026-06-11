# Prompt — Architecture Review: UI-Triggered EKS Job with Real-Time Progress

> **Phase 1 of 2 — Review & gap analysis only. Do NOT write or modify any code in this pass.**
> The output of this prompt is a written report. A separate phase-2 prompt will handle implementation once we've agreed on the gaps.

---

## Role & objective

You are a senior platform engineer auditing the Tucaken codebase. The feature under review is the path where the **UI triggers a Kubernetes Job on EKS and watches its execution progress in real time** (e.g. the Article / Strategist / Coaching pipelines and onboarding jobs).

Your job in this pass is to **produce a gap-analysis report** that:
1. Documents how this flow is *currently* implemented, with exact file/line citations.
2. Compares it against the **target architecture** defined below.
3. Rates each dimension and produces a prioritized list of gaps.

This is **read-only**. Do not edit files, do not propose diffs, do not run migrations. If you are tempted to fix something, record it as a finding instead.

---

## Step 0 — Orient

1. Read `CLAUDE.md` (and any nested ones) to understand repo structure, conventions, and the deployment topology.
2. Map the repos/services involved in this flow. State which repo and service owns the trigger API, the worker/Job, and the frontend.
3. If the relevant code lives across multiple repos and you only have one in context, say so explicitly and list what you cannot see.

## Step 1 — Discover the current implementation

Locate and read each of the following. For everything you cite, give `path:line`. If a component does not exist, say "not found" — absence is itself a finding.

- **Trigger endpoint(s):** the API route(s) the UI calls to start a job. Note the HTTP method, the response shape, and whether it blocks until completion or returns immediately.
- **Kubernetes client usage:** where and how the backend creates the Job (client library, auth mechanism, namespace, how the Job spec is built — inline, templated, or a CRD/operator).
- **Job spec:** the Job/Pod manifest or template. Capture `backoffLimit`, `activeDeadlineSeconds`, `ttlSecondsAfterFinished`, resource requests/limits, and the image/command.
- **Cluster auth:** the `ServiceAccount`, `Role`/`RoleBinding` (or Cluster equivalents), and any IRSA annotation (`eks.amazonaws.com/role-arn`). Record the exact verbs/resources granted.
- **Streaming transport:** the endpoint that pushes progress to the browser — SSE, WebSocket, or polling. Note how the connection is held and terminated.
- **Progress source:** determine whether progress comes from (a) the Kubernetes resource status via watch/informer, (b) the workload emitting its own domain events, or (c) both. This distinction is the crux of the review — be precise.
- **Message bus / fan-out:** any Redis / NATS / queue usage on this path. If Redis, identify whether it uses **Pub/Sub** or **Streams**, and the channel/key naming.
- **Frontend:** the code that triggers the job and subscribes to updates (e.g. `EventSource`, `fetch` stream, polling loop). Note reconnection handling and how final state is rendered.
- **Persistence:** any database (RDS/Postgres) table tracking job state, and whether the UI reconciles from it on reload.

## Step 2 — Target architecture (reference for comparison)

Compare what you found against this design. It is the intended end state.

**Trigger path**
- The browser never talks to the kube-apiserver. UI → ALB/Ingress → backend (FastAPI).
- The backend authenticates the user, then creates the Job via the Kubernetes client. On EKS this is **IRSA**: the pod's `ServiceAccount` is annotated with an IAM role ARN, and a least-privilege `Role`/`RoleBinding` grants `create, get, list, watch` on `jobs`, `pods`, and `pods/log` in the target namespace only.
- The trigger endpoint returns **`202 Accepted` + a `jobId` immediately**. It does not block on job completion.

**Real-time progress path**
- The browser subscribes via **SSE** (`EventSource`) — one-directional server→client, simpler than WebSockets and with native reconnection.
- The backend assembles the stream from **two distinct sources**:
  - **Lifecycle** (`Pending → Running → Succeeded/Failed`) from the Kubernetes **watch API / informer**.
  - **Domain progress** ("step 3 of 7") emitted by the **workload itself** — Kubernetes has no knowledge of business-logic progress, so granular progress must be application-emitted.
- The Job publishes progress to **Redis Streams** (not Pub/Sub). The backend subscribes and forwards events as SSE.

**Production-hardening requirements**
- **Fan-out:** with more than one backend replica behind the ALB, the SSE connection may land on a different pod than the one that created the Job. Redis decouples them — the Job publishes to `job:{id}`; whichever replica holds the connection is subscribed. Required for any multi-replica deployment.
- **Reconnection durability:** Redis **Streams** (not Pub/Sub) so a client reconnecting mid-job can replay missed events using SSE's `Last-Event-ID` header. Pub/Sub silently drops events when no subscriber is attached.
- **Persistence:** final job state is written to **Postgres**; the UI reconciles from the DB on reload rather than relying on the ephemeral stream. Stream for live, DB for source-of-truth.
- **Job hygiene:** `ttlSecondsAfterFinished` (auto-GC), `backoffLimit`, `activeDeadlineSeconds`, and resource limits set on every Job.
- **Authorization on the stream:** the SSE endpoint must verify the requesting user owns `jobId` — user A must not be able to read user B's stream. No job IDs or sensitive data in URL query strings.

## Step 3 — Compare across these dimensions

For each dimension, record: **Current state** → **Target state** → **Gap** → **Severity**.

| # | Dimension | What to check |
|---|-----------|---------------|
| 1 | Client/server boundary | UI hits backend, not kube-apiserver directly |
| 2 | Async trigger | Non-blocking `202` + `jobId`, not a long-held request |
| 3 | Cluster auth | IRSA + least-privilege RBAC (correct verbs/resources, namespace-scoped) |
| 4 | Streaming transport | SSE vs WebSocket vs polling; fit for purpose |
| 5 | Progress source | Domain progress (workload-emitted) vs lifecycle-only |
| 6 | Message bus / fan-out | Redis present; multi-replica safe |
| 7 | Reconnection durability | Streams vs Pub/Sub; `Last-Event-ID` replay |
| 8 | State persistence | Final state in Postgres; UI reconciles on reload |
| 9 | Job lifecycle hygiene | `ttlSecondsAfterFinished`, `backoffLimit`, `activeDeadlineSeconds`, limits |
| 10 | Failure handling | Job failure/timeout surfaced to the UI; partial-failure behaviour |
| 11 | Stream authorization | Per-user ownership check on `jobId`; no sensitive data in URLs |
| 12 | Observability | Log streaming, metrics, tracing across the path |

**Severity scale:**
- **Critical** — breaks correctness, security, or multi-replica scaling.
- **Important** — works today but fails under load, on reconnect, or at an edge.
- **Minor** — polish / consistency.
- **Aligned** — already matches target.

## Step 4 — Output format

Produce a single report with these sections, in order:

1. **Executive summary** — 3–5 sentences. Overall alignment rating, and the single most important gap.
2. **Summary table** — the dimension table from Step 3 with Current / Target / Severity filled in.
3. **Detailed findings** — one subsection per dimension that is not "Aligned", each with `path:line` evidence, what the target expects, and why the gap matters. Be concrete; quote configuration values, not impressions.
4. **Prioritized gap list** — Critical → Important → Minor, as an ordered list. This becomes the input to the phase-2 implementation prompt.
5. **Open questions & assumptions** — anything you couldn't see, any inference you made, and any decision that needs my input before implementation (e.g. "is multi-replica a current requirement?").

## Constraints

- **Read-only.** No edits, no diffs, no commands that mutate state.
- **Cite everything** with `path:line`. No claim about the current code without a reference.
- **Don't guess.** If a file isn't in context or a behaviour is ambiguous, list it under open questions rather than inventing an answer.
- **Distinguish "absent" from "different."** A missing component and a component implemented differently are separate findings.
- Keep impressions out of the findings — evidence and config values only.