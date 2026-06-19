# Feature Specification: Tiered Enrichment

**Feature Branch**: `feat/tiered-enrichment`

**Created**: 2026-06-19

**Status**: Draft

**Input**: Demote the LLM from the default enrichment path to a thin batched fallback via a cheap-to-expensive cascade (deterministic tech JOIN → ontology skill rules → embedding classification → batched LLM residual), cutting per-repo enrichment cost ~90% with no quality loss, all emitting a controlled vocabulary.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Deterministic technologies, no LLM (Priority: P1) — MVP

Today every chunk's `technologies` come from an LLM call (now decommissioned, so the field is empty), even though a deterministic extractor already produces file-cited technologies for the repo. The operator wants chunk technologies populated authoritatively and for free, from the evidence that already exists.

**Why this priority**: It is the cheapest, highest-confidence slice — it removes a whole reason the per-chunk LLM call exists, makes technologies *more* accurate (file-cited, not inferred), and repopulates the array-overlap retrieval lane. Shippable alone.

**Independent Test**: Enrich a repo; every chunk whose file has technology evidence gets those technologies, sourced by JOIN (zero model calls), and they match the deterministic extractor's file-cited output.

**Acceptance Scenarios**:

1. **Given** a file with deterministic technology evidence, **When** its chunks are enriched, **Then** each chunk's `technologies` equals that file's evidenced technologies (canonical names), with no model call.
2. **Given** a chunk whose file has no technology evidence, **When** enriched, **Then** its `technologies` is empty (not hallucinated) and it passes to later tiers for skills.

---

### User Story 2 - Ontology-driven skills, no LLM (Priority: P1)

Most code chunks evidence skills that are *implied* by their imports and structure (a CDK construct → infrastructure-as-code; a Kubernetes NetworkPolicy → kubernetes networking). The operator wants those skills assigned deterministically from the technologies/structure already parsed, without an LLM call.

**Why this priority**: For code repos this resolves the majority of chunks deterministically, collapsing the LLM population dramatically. Builds directly on US1's technologies.

**Independent Test**: A chunk whose file evidences a mapped technology/structure receives the mapped canonical skill(s) with no model call; a chunk with no mapped signal passes to later tiers.

**Acceptance Scenarios**:

1. **Given** a chunk on a file evidencing a technology with a skill mapping, **When** enriched, **Then** it receives the mapped canonical skill(s) deterministically.
2. **Given** a mapping that would tag a skill the chunk does not evidence, **When** enriched, **Then** the precision guard prevents the tag (no over-tagging beyond the file's evidence).

---

### User Story 3 - Embedding classification for residual skills (Priority: P1)

For chunks the rule tier can't confidently tag, the operator wants skills assigned by comparing the chunk's *existing* embedding to the embedded skill vocabulary — no new model call.

**Why this priority**: Captures semantic skills the rules miss at near-zero marginal cost (the chunk and the labels are already embedded), shrinking the LLM residue to a thin tail.

**Independent Test**: A residual chunk whose embedding is within threshold of a skill label gets that canonical skill; below threshold it passes to the LLM tier. Precision/recall vs the per-chunk baseline meets the gate.

**Acceptance Scenarios**:

1. **Given** a residual chunk semantically near a skill label, **When** classified, **Then** it receives that canonical skill above the tuned threshold.
2. **Given** a residual chunk near no label, **When** classified, **Then** it is left for the LLM tier rather than mis-tagged.

---

### User Story 4 - Batched LLM only for the thin residue (Priority: P2)

Only genuinely ambiguous chunks (novel capability inference on prose the rules/embeddings can't resolve) reach the LLM. The operator wants those handled cheaply — many chunks per call, cached prompt, batched — and **deferred** so sync/resync stays fast.

**Why this priority**: Irreducible residual judgement, but it must not dominate cost or block sync. Last and smallest.

**Independent Test**: After Tiers 0–2, only the residue (target ≤25% of chunks) is sent to the LLM, as batched multi-chunk calls; sync/resync completes without waiting on it; the residue's skills land after the batch finishes.

**Acceptance Scenarios**:

1. **Given** a residue of ambiguous chunks, **When** the LLM tier runs, **Then** it packs many chunks per call and submits asynchronously (batched), not one call per chunk.
2. **Given** an in-progress LLM batch, **When** the user syncs, **Then** the repo is already searchable from Tiers 0–2 and the residue's skills fill in when the batch completes — the user never waits on the LLM.

---

### Cross-Cutting Story A - Controlled vocabulary everywhere (Priority: P1)

Every tier emits **canonical** skill terms only, so the array-overlap retrieval lane matches reliably.

**Independent Test**: No tier writes a non-canonical skill; the `&&` overlap lane matches a query skill against chunks tagged by any tier.

### Cross-Cutting Story B - Content-hash dedup cache (Priority: P2)

Enrichment output is cached by chunk content-hash (reusing the existing cache), so identical content across repos/re-syncs is never recomputed — at any tier, including the LLM.

**Independent Test**: Two chunks with identical content (same hash) trigger one computation; the second is a cache hit with no recompute.

---

### Edge Cases

- A chunk whose file has technology evidence but whose own content doesn't evidence the skill the rule would imply: the precision guard must not over-tag (per-chunk evidence, not file-blanket).
- The deterministic extractor and the chunker disagree on file paths (renames, monorepo prefixes): the JOIN must use the same canonical file key both sides use.
- Tier 2 threshold too low → false skills (precision loss); too high → recall loss. Must be eval-tuned, not guessed.
- The LLM batch is delayed/fails: residue chunks must remain retryable (not silently skill-less forever) and the rest of the repo is unaffected.
- A re-sync where content is unchanged: hash-skip + the dedup cache must avoid recomputation entirely.
- Prompt caching may be unavailable for the model/region or below its minimum cached-prefix size — the design must not depend on it for correctness or for the Tier 0–2 savings.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Chunk `technologies` MUST be populated deterministically by joining the existing file-cited technology evidence to chunks by file, with zero model calls, replacing LLM-derived technologies.
- **FR-002**: Skills MUST be assigned deterministically where implied by a chunk's file technologies/structure, via a maintained technology/structure → canonical-skill mapping, with zero model calls.
- **FR-003**: Residual chunks (no deterministic skill) MUST be classified against the embedded skill vocabulary using their existing embedding (no new model call), assigning canonical skills above a tuned similarity threshold.
- **FR-004**: Only chunks unresolved by Tiers 0–2 MAY reach the LLM, which MUST process them as batched multi-chunk calls (not one-per-chunk) and SHOULD cache the shared prompt prefix where the platform supports it.
- **FR-005**: The LLM tier MUST be deferrable/asynchronous so sync/resync is not blocked on it; Tiers 0–2 run inline so the repo is searchable immediately, and the LLM residue's skills are filled in when the batch completes.
- **FR-006**: Every tier MUST emit only canonical vocabulary terms, so the array-overlap retrieval lane matches.
- **FR-007**: Each tier MUST be guarded by its own eval comparing its output to the per-chunk LLM baseline on a labelled sample (recall + precision), run before the tier is relied upon; no tier ships on assertion alone.
- **FR-008**: A tier MUST NOT tag a chunk with a skill/technology the chunk does not evidence (precision guard), even when the file as a whole evidences it.
- **FR-009**: Enrichment output MUST be deduplicated by chunk content-hash via the existing cache, so identical content is computed once across repos and re-syncs.
- **FR-010**: The cascade MUST be fail-safe and incremental: a tier's failure degrades to the next available path (ultimately the existing per-chunk LLM enrichment), never zero skills; each tier is independently enable-able.
- **FR-011**: Bedrock prompt-caching availability + minimum cached-prefix size for the enrichment model/region MUST be verified before any caching saving is claimed; the Tier 0–2 savings MUST NOT depend on it.

### Key Entities *(include if feature involves data)*

- **Technology evidence**: existing file-cited, confidence-scored technology records (user, repo, file) — the Tier 0 JOIN source.
- **Technology/structure → skill mapping**: the maintained rules that turn deterministic technology/structure signals into canonical skills (Tier 1).
- **Skill vocabulary embeddings**: the embedded canonical skill labels used as classification targets (Tier 2).
- **Enrichment cache entry**: canonicalised skills/technologies keyed by chunk content-hash (cross-cutting dedup).
- **Enrichment tier outcome**: per chunk, which tier resolved it (for cost/coverage measurement and the eval).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Per-repo enrichment cost drops from the ~$5.90 baseline toward ~$0.35–0.50 (~90% reduction), measured against live cost telemetry.
- **SC-002**: The share of chunks reaching the LLM falls to ≤25% (target ~10–25%); Tiers 0–2 resolve the rest with zero model calls.
- **SC-003**: Chunk technologies are file-cited and match the deterministic extractor — technologies accuracy does not fall (and improves over the LLM-inferred baseline).
- **SC-004**: Per-tier skill recall is ≥ the per-chunk LLM baseline and precision does not fall (no over-tagging), on the labelled eval, for every enabled tier.
- **SC-005**: The array-overlap retrieval lane matches reliably — no skill is written in a non-canonical form by any tier.
- **SC-006**: Sync/resync wall-clock to "repo searchable" does not regress: Tiers 0–2 complete inline; the LLM residue is asynchronous.
- **SC-007**: Identical-content chunks recompute once — measured cache-hit rate > 0 on re-sync/cross-repo duplicates.

## Assumptions

- The deterministic technology extractor's file keys and the chunker's file paths can be reconciled to a common key for the JOIN.
- The existing skill vocabulary (canonical labels, embedded) is the controlled vocabulary for all tiers; its coverage is sufficient that Tiers 0–2 resolve the majority of chunks (validated by SC-002, else the residue simply stays larger — still cheaper than today).
- "At least as good as today" is judged against the existing per-chunk LLM enrichment as the baseline on a labelled sample, tier by tier (the resolver already canonicalises, so equality is semantic, not exact-string).
- The LLM tier reuses the verified Bedrock batch infrastructure for its asynchronous submission; the deferred-collection mechanism is a design choice for the plan.
- The content-hash dedup reuses the existing cache cluster; cache misses fall through to compute (never a correctness dependency).
- Baseline figures (~$5.90/repo, 3,932 chunks, 17,350 evidence rows / 1,761 files, 209 embedded labels, 0/12,236 chunks with technologies today) are measured on the live dev system, used only as the comparison point.
