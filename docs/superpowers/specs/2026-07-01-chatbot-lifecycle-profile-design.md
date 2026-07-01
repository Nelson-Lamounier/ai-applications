# Design — Lifecycle-aware repository profiles (Layer 2)

- **Date:** 2026-07-01
- **Repo:** ai-applications
- **Branch:** fix/chatbot-lifecycle-profile (from origin/develop)
- **Depends on:** Layer 1 (fix/chatbot-data-driven-prompt) — the data-driven system prompt is the base this stacks on.
- **Status:** draft design, pending review

## Problem

The portfolio chatbot answers "how is your Kubernetes cluster set up?" with a
retired self-managed kubeadm story, even though the live cluster is Amazon EKS
1.34 (`k8s-eks-development`, verified 2026-07-01). Layer 1 removed the hardcoded
prompt facts, but a live probe of the pgvector store (read-only query via the
admin-api pod -> PgBouncer -> RDS on 2026-07-01) shows the **data itself still
carries the old story**:

| Term | Live chunk count (of 13,579) |
| --- | --- |
| kubeadm | 428 |
| calico | 307 |
| golden ami | 112 |
| self-managed | 70 |
| EKS | 388 |
| karpenter | 144 |

Stale chunks trace to three synced repos:

| Repo | Stale content | Last embedded |
| --- | --- | --- |
| `frontend-portfolio` | `apps/site/src/lib/resumes/resume-data-esc.ts` — "Self-managed Kubernetes (kubeadm, kubelet, etcd)" | 2026-06-24 |
| `tucaken-app` | `src/lib/resumes/resume-data-esc.ts` — same | 2026-06-20 |
| `kubernetes-bootstrap` | `sm-a/boot/**` — retained kubeadm bootstrap code + `kubeadm-init.test.ts` | 2026-06-20 |

The profile layer is largely EKS-correct, but the **chunk layer** holds ~428
kubeadm vs ~388 EKS chunks, so retrieval can surface the historical story with
equal authority.

### Root cause

The KB has **no concept of time**. A retired kubeadm chunk and a current EKS
chunk occupy the same vector space with equal standing; retrieval cannot tell
"used to be" from "is". Deleting history is lossy — the migration is real,
valuable experience.

## Principle

Give the profile a **lifecycle dimension**: represent system change (migration
from a prior state to a current state) as a first-class, structured fact, so the
chatbot answers temporally — "currently Amazon EKS, migrated from self-managed
kubeadm" — and current state is authoritative. Because it is structured and
extracted per repo, it **replicates** to any repo/system that changes.

## Scope

**In scope (Layer 2):**
1. A structured `lifecycle` field on the repository profile (extraction + schema + persistence).
2. A dedicated embedded `lifecycle` chunk so the fact is retrievable and injected into chatbot context.
3. A temporal-framing instruction in the chatbot system prompt (stacks on Layer 1).
4. Ingestion exclusions for truly-decommissioned content (`resume-data-esc.ts`, `sm-a/`).
5. Purge of already-embedded rows for the excluded paths.
6. Re-ingestion of the affected repos to populate lifecycle + refresh embeddings.
7. Verification via the live chunk-probe + a retrieval probe.

**Out of scope (would be separate specs):** a generalised timeline/event
subsystem (its own table, dated events, timeline UI). This spec deliberately
takes the targeted-field approach.

## Design

Component-by-component. All code paths verified against the repo.

### 1. Lifecycle data shape — `ProfileExtractor`

`applications/ingestion/src/agents/ProfileExtractor.ts`:

- Extend `ExtractedRepoDataSchema` (lines 9–38) with a new optional field:

  ```
  lifecycle: z.array(z.object({
    system: z.string().transform(s => s.slice(0, 80)),   // e.g. "Kubernetes platform"
    from:   z.string().transform(s => s.slice(0, 120)),  // prior state
    to:     z.string().transform(s => s.slice(0, 120)),  // current state
    when:   z.string().nullable(),                       // e.g. "2026-05"
    status: z.enum(['current', 'planned', 'deprecated']),
  })).max(5).default([])
  ```

- Add the same field to `EXTRACT_TOOL.input_schema` (lines 50–93) and a grounding
  rule to `SYSTEM_PROMPT` (lines 95–122): populate `lifecycle` ONLY from explicit
  evidence (README migration notes, CHANGELOG, ADRs); never infer a migration
  that is not stated. Empty array when no migration evidence exists.

The field flows unchanged into persistence: `RepositoryProfileRepository.upsert()`
writes the whole `ExtractedRepoData` into the `repository_profiles.extracted`
JSONB column (`014_repository_profiles.sql:15`; write at
`RepositoryProfileRepository.ts:73`). No repository code change needed beyond the
type — `extracted` is opaque JSONB.

### 2. Embedded `lifecycle` chunk

The chatbot context-builder injects only chunk **content**, not structured
profile fields (`context-builder.ts:52–55` formats `p.text`; structured
`extracted` fields are not surfaced). Therefore the lifecycle fact must become an
**embedded chunk** to reach the model.

- **Migration `104_add_profile_lifecycle_chunk_type.sql`** (next free number;
  current CHECK at `014_repository_profiles.sql:83`): extend the
  `repository_profile_embeddings.chunk_type` CHECK to include `'lifecycle'`.
- **`embedProfile()`** (`run-ingestion.ts:360–385`): when `extracted.lifecycle`
  is non-empty, render each entry to a sentence and embed it as a chunk with
  `chunkType: 'lifecycle'`, e.g.
  `"Kubernetes platform: currently Amazon EKS 1.34, migrated from self-managed kubeadm (2026-05)."`
- **`ProfileEmbeddingRow.chunkType`** union (`RepositoryProfileEmbeddingsRepository.ts:7–15`)
  gains `'lifecycle'`.

Retrieval needs no change: `PgVectorRetriever.queryProfileLayer()` already
vector-searches all `repository_profile_embeddings` rows regardless of
`chunk_type`, and returns the content as a `RetrievedPassage` with
`source: 'profile'`, which the context-builder injects.

### 3. Temporal-framing prompt rule

Add to the chatbot system prompt (the Layer 1 file
`applications/shared/src/chatbot/system-prompt.ts`): when the retrieved context
contains lifecycle/migration information, lead with the current state as
authoritative and present prior states as history ("migrated from X to Y");
never present a superseded state as current. One short instruction, no facts.
This change assumes the Layer 1 refactor is the base.

### 4. Ingestion exclusions

`applications/shared/src/ingestion/implementations/FileFilter.ts`, extend
`DEFAULT_FILTER_CONFIG.exclude` (lines 147–201; exclude takes precedence at
line 226):

- `**/resume-data-esc.ts` — decommissioned ESC resume (both portfolio repos).
- `**/sm-a/**` — retired kubeadm bootstrap stack in kubernetes-bootstrap
  (its migration is preserved as a lifecycle fact instead of raw code).

Rationale: these are the dominant kubeadm/Calico/golden-AMI sources; the
migration story they represented is captured structurally by the lifecycle
field, so the raw retired code/resume no longer needs to be searchable.

### 5. Purge already-embedded rows

Exclusions stop future embedding but do not remove existing rows. Delete the
stale rows for the excluded paths from `document_embeddings` for the affected
repos (read-only-verified pattern; run as a bounded, parameterised DELETE via the
admin-api pod -> PgBouncer, same access path used for the probe):

```
DELETE FROM document_embeddings
 WHERE repo_full_name = ANY($1)
   AND (file_path LIKE '%/resume-data-esc.ts' OR file_path LIKE '%/sm-a/%');
```

Scoped to `frontend-portfolio`, `tucaken-app`, `kubernetes-bootstrap`.

### 6. Re-ingest affected repos

Re-ingest with `FORCE_REINDEX=true` so profiles are re-extracted (populating
`lifecycle`) and chunks re-embedded under the updated filter, and so
kubernetes-bootstrap's current EKS-primary README (corrected 2026-06-25, last
embedded 2026-06-20) finally lands:

- `frontend-portfolio`, `tucaken-app`, `kubernetes-bootstrap`, `kubernetes-platform`, `tucaken-infra`.

**Trigger mechanism — OPEN DECISION** (default: product path): the admin
dashboard / `POST /api/admin/ingestion/trigger` (Cognito JWT, `{ repoFullName }`)
per repo; fallback is a `kubectl` one-shot Job from `cronjob/ingestion-cronjob`
with `FORCE_REINDEX=true`.

### 7. Verify

- Re-run the chunk-probe: kubeadm/calico/golden-AMI counts drop sharply;
  `chunk_type='lifecycle'` rows present for the platform repos; EKS remains.
- Retrieval probe: run the cluster question through `PgVectorRetriever` for the
  portfolio owner and confirm the top passages are EKS/lifecycle, not kubeadm.

## Testing

Jest (`@jest/globals`), following existing patterns:

- `applications/ingestion/src/agents/__tests__/ProfileExtractor.test.ts` — extend:
  a well-formed tool response including `lifecycle` yields a validated
  `lifecycle` array; over-long/over-count entries are clamped (mirrors existing
  clamp tests); absent lifecycle defaults to `[]`.
- `embedProfile` test: a profile with a `lifecycle` entry produces a
  `chunkType: 'lifecycle'` embedding row; empty lifecycle produces none.
- Migration applies cleanly on a scratch DB and the new CHECK accepts
  `'lifecycle'` and still rejects unknown types.
- FileFilter test: `**/resume-data-esc.ts` and `**/sm-a/**` are excluded; a
  sibling legitimate file is still included.

## Risks

- **Extractor invents a migration.** Mitigated by the grounding rule (evidence-only)
  and the existing extractor's evidence discipline; covered by a test asserting
  empty `lifecycle` when no migration evidence is present.
- **Purge deletes too much.** Mitigated by a narrow, parameterised `LIKE` scoped
  to named repos and specific path patterns; dry-run `SELECT` the row set first.
- **Migration + live re-ingest are irreversible-ish ops.** Run against dev first
  (this account), verify, then promote.
- **Depends on Layer 1.** The prompt change stacks on the Layer 1 refactor; land
  or rebase on Layer 1 before the prompt task.

## Open decisions for review

1. Re-ingest trigger mechanism (admin UI / admin-api script / kubectl Job) — default admin UI.
2. Confirm the exclusion list (`resume-data-esc.ts`, `sm-a/`) — anything else retired?
3. Lifecycle as a dedicated `chunk_type` (recommended, this spec) vs folding into `description` (no migration). Recommended path chosen for clean retrieval + replicability.
