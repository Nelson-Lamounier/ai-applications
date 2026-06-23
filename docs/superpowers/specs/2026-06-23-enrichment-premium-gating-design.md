# Enrichment as a Premium Feature — gating + free Tier-1 + test-user UI toggle

- **Date:** 2026-06-23
- **Status:** Design approved, awaiting spec review
- **Repos:** ai-applications (ingestion) + tucaken-app (admin-api + frontend)
- **Branch:** `spec/enrichment-premium-gating` (ai-applications; tucaken-app gets its own branch)

## Problem

Chunk-skill **enrichment** (`BedrockChunkEnricher`, Claude Haiku, one call per chunk)
is ~99% of repository ingestion LLM cost — **$6.87–$10.11 per repo per run**
(measured from `prompt_invocations`: 7,188 Haiku calls / 56M input tokens for
ai-applications alone). Re-ingestions re-pay it, so the 45-day total reached
$54/$20/$21/$21 across the four repos.

Everything else is cheap or free:
- **Embeddings** (Titan, the RAG/KB) = **$0.02–$0.10 per repo**.
- **Technology extraction** (`technology_evidence` via Syft SBOM / GitHub SBOM /
  tree-sitter / IaC + Dockerfile parsers) = **$0.00, fully deterministic, a
  separate K8s Job**, read by the resume/JD via `TechnologyOntologyRepository`.

Enrichment is cleanly separable: RAG retrieval works without it; technologies come
from a different pipeline entirely. So enrichment should become a **premium** add-on
while the **free tier keeps ingestion + RAG/KB + technologies** at ~€0 LLM cost.

## Goals

- **Gate the LLM chunk-enrichment behind a premium entitlement.** Free tier runs
  **Tier-1 deterministic** skill assignment ($0, ~33% of chunks via
  `tech_skill_map`) and **skips the LLM** enrichment; premium runs full enrichment.
- **A test-user UI toggle** (modal on "Connected Repositories → add / re-sync repo")
  letting `lamounier_88@hotmail.com` choose *Full enrichment (premium)* vs
  *Free-tier sync* per repo. Gated to that test-user only; choice enforced
  server-side.
- **Start cutting the premium cost:** enable `ENRICH_PER_FILE` for the premium path
  (~3.7× fewer calls, ~€7 → ~€2/repo) and investigate the 0-cache-hit dedup finding.
- Technology extraction + RAG/KB untouched.

## Non-goals

- No billing system; no `user_entitlements` DB table (env allowlist now, DB later).
- No upgrade-backfill flow (enriching a free user's existing repos on upgrade) — a
  separate PR using the existing `run-reenrich` machinery.
- Pack/batch enrichment levers (`ENRICH_PACK`/`ENRICH_BATCH`) — follow-ups.
- No change to tech extraction, embeddings, or RAG retrieval.

## Verified facts (queried + code-read, not assumed)

- Per-repo single-run enrichment cost (busiest day): ai-applications $10.11 (7,188
  calls), kubernetes-bootstrap $8.98, tucaken-app $6.93, tucaken-infra $6.87.
- `prompt_invocations` has **no** tech-extraction agent/cost — tech extraction is
  deterministic.
- `run-ingestion.ts`: `ENRICHMENT_DISABLED` gates the LLM enricher construction
  (`:625`); `ENRICH_TIER1` loads the deterministic `tech_skill_map` (`:220`);
  `ENRICH_PER_FILE` is an existing lever. Tier-1 is applied inside
  `reenrichSkippedChunks(enricher, { tier1Map, … })`, which today only runs when an
  LLM `enricher` exists (`runDeferredEnrichment` is gated on `deferEnrichment &&
  enricher`) — so the free "Tier-1-only" path needs a small decoupling.

## Design

### Surface 1 — ai-applications: the ingestion gate + Tier-1-without-LLM

**1a. Env-driven gate (mostly existing flags).** The ingestion job already reads
`ENRICHMENT_DISABLED`, `ENRICH_TIER1`, `ENRICH_PER_FILE`. The dispatcher (Surface 2)
sets them:
- **Free:** `ENRICHMENT_DISABLED=1` + `ENRICH_TIER1=1`.
- **Premium:** (enrichment on) + `ENRICH_TIER1=1` + `ENRICH_PER_FILE=1` + dedup on.

**1b. Tier-1-without-LLM seam (the one real code change).** Today Tier-1 runs only
alongside an LLM enricher. Add a deterministic Tier-1 pass that runs when
`ENRICHMENT_DISABLED=1 && ENRICH_TIER1=1`: it applies `tier1SkillsFromTech` skills to
chunks from `tech_skill_map` and **does not** call the LLM (the unresolved remainder
stays `pending`/empty — no charge). Implement by making the LLM fallback in the
Tier-1 path optional (a "tier1-only" mode / `enricher?` optional in
`reenrichSkippedChunks`), and invoke it from `run-ingestion.ts` even when the LLM
enricher is absent. Pure DB lookup + skill assignment; unit-testable; no Bedrock.

**1c. Per-file lever for premium (Pillar 2).** `ENRICH_PER_FILE=1` on the premium
path (set by the dispatcher). Confirm the existing per-file path is correct + that
its skills re-fan to chunks under the evidence guard.

**1d. Dedup finding.** Investigate why `chunk_enrichment_cache` shows 0 hits on
re-ingestions (the content-hash key likely excludes something that changes per run).
If a quick keying fix, include it; else log as a follow-up with the finding.

**1e. Telemetry.** Log the resolved enrichment mode (`premium` | `free-tier1-only`)
and the per-run `chunk-enrich` cost (already summed via `sumBookedCostUsd`) so a free
run is visibly ~€0.

### Surface 2 — tucaken-app/admin-api: entitlement + dispatch

**2a. `isEnrichmentToggleAllowed(email)`** — a new allowlist
(`ENRICHMENT_TOGGLE_EMAILS`, default `lamounier_88@hotmail.com`), mirroring the
existing `isFreeTierAllowed`/`AB_FREE_TIER_EMAILS` pattern (env-read at call time).

**2b. `me.enrichmentToggle`** — expose the flag on the `me` route (like
`me.abFreeTier`) so the frontend shows the modal only for the test-user.

**2c. Accept + enforce the choice.** The repo add/sync endpoint accepts an
`enrichment: 'premium' | 'free'` field. Server-side enforcement (mirror
`resolveDispatchMode`): the choice is honoured **only** when
`isEnrichmentToggleAllowed(email)`; otherwise the default applies (current behaviour
preserved for everyone else). The resolved choice maps to the ingestion Job's env
(`ENRICHMENT_DISABLED`/`ENRICH_TIER1`/`ENRICH_PER_FILE`) in the K8s job builder.

**2d. Default for non-test users.** Unchanged current behaviour (no regression);
only the test-user gets the per-repo choice for now.

### Surface 3 — tucaken-app frontend: the toggle modal (test-user only)

A modal/toggle in the **Connected Repositories → add repository (and re-sync)** flow:
- Two choices: **Full enrichment (premium)** vs **Free-tier sync** (RAG/KB +
  technologies, no skill enrichment), each with a one-line plain-language note.
- Rendered **only** when `me.enrichmentToggle` is true (the test-user); everyone
  else sees the current flow unchanged.
- Sends `enrichment: 'premium' | 'free'` with the sync request; the server enforces.
- Mirrors the resume A/B `TierActions` component pattern (the `me`-flag gate +
  capture-and-send + server-side enforcement).

## Architecture / data flow

```
Frontend (test-user): add/re-sync repo modal → enrichment: 'premium' | 'free'
        │
        ▼
admin-api: isEnrichmentToggleAllowed(email)?  honour choice : default
        │  → K8s ingestion Job env:
        │     free    → ENRICHMENT_DISABLED=1, ENRICH_TIER1=1
        │     premium → (enrich on), ENRICH_TIER1=1, ENRICH_PER_FILE=1, dedup
        ▼
ingestion job (ai-applications):
   chunk → embed (Titan) → document_embeddings        [RAG/KB — both tiers]
   Tier-1 deterministic skills (tech_skill_map)        [both tiers, $0]
   LLM chunk-enrich (Haiku)                            [PREMIUM ONLY]
tech-extractor job (separate, deterministic)          [both tiers, $0]
```

## Error handling
- Tier-1-only pass fail-open: a missing `tech_skill_map`/no `file_tech_stack` →
  chunks simply get no Tier-1 skills (still embedded + retrievable); never blocks.
- Server-side enforcement fails closed to the DEFAULT (not to premium) if the email
  is not allowlisted — a non-test user can never trigger a paid enrichment via a
  crafted request beyond the existing default.
- Dispatch/env mapping is additive; absent flags = current behaviour.

## Testing
- **ai-applications unit:** the Tier-1-only pass applies deterministic skills and
  makes **zero** Bedrock calls; `ENRICHMENT_DISABLED=1 + ENRICH_TIER1=1` produces a
  pipeline with no enricher.
- **admin-api unit:** `isEnrichmentToggleAllowed` (allowlist); the enforcement maps
  test-user `free` → `ENRICHMENT_DISABLED=1 + ENRICH_TIER1=1`, test-user `premium` →
  per-file env; a non-allowlisted email's `free`/`premium` request → default.
- **frontend:** the modal renders only when `me.enrichmentToggle`; sends the chosen
  value; wrapped tests don't regress the add-repo flow.
- **Manual E2E (the user's test):** the test-user adds a **not-yet-enriched** repo
  as *Free-tier sync* → `document_embeddings` populated, **zero `chunk-enrich`
  invocations** in `prompt_invocations`, Tier-1 skills on ~33% of chunks,
  technologies + RAG intact, then a JD run still produces a resume. A *premium* sync
  → enrichment runs with materially fewer calls (`ENRICH_PER_FILE`).

## Acceptance criteria
- Free-tier repo sync incurs **zero `chunk-enrich` LLM cost**; RAG/KB + technologies
  + Tier-1 deterministic skills present.
- Premium sync enriches with `ENRICH_PER_FILE` (fewer calls than per-chunk).
- The test-user sees the toggle; the choice is honoured only for the allowlisted
  email and enforced server-side; non-test users are unaffected.
- Tech extraction, embeddings, RAG retrieval unchanged.
- No migration; ESLint + typecheck clean on both repos; evals/tests green.

## Risks & mitigations
- **Tier-1-only decoupling touches the enrich path:** keep it a small, additive
  "tier1-only" mode behind the existing flags; unit-test that it makes no LLM call;
  the premium/inline path is unchanged.
- **Free tier feels degraded (fewer skills):** Tier-1 gives ~33% deterministic skill
  coverage + full technologies + RAG; the UI note sets expectations; premium is the
  upgrade.
- **Server-side bypass:** enforcement keyed to the allowlisted email, fail-closed to
  default; the env is set by the trusted dispatcher, never the client.
- **Cross-repo coordination:** ship ai-applications (the gate honours the env) first
  or behind a default that preserves current behaviour, so the admin-api/frontend
  can roll out without a breaking ordering dependency.
