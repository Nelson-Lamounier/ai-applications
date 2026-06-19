# Feature Specification: Chunk-Packing for Enrichment

**Feature Branch**: `feat/chunk-packing`

**Created**: 2026-06-19

**Status**: Draft

**Input**: Pack many chunks into one Haiku call that returns skills per chunk, amortising the shared system prompt — cutting per-repo enrichment cost ~60–75% with the per-chunk skills unchanged, proven by a packed-vs-per-chunk eval.

## Why this approach (context)

Two prior attempts to cut enrichment cost by AVOIDING the model failed their evals — per-file granularity (recall 0.118) and deterministic tech→skill mapping (recall 0.163) both drop ~84% of skills, because the model's per-chunk judgement is not mechanically derivable. The cost must be cut by **amortising** the call, not replacing it: the ~700-token system prompt is re-sent on all 3,932 per-repo calls and dominates the ~$5.90 bill. Packing many chunks into one call pays the system prompt once per pack while the model still reads + judges every chunk individually — so the skills are unchanged.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Re-enriching a repo costs far less, with the same skills (Priority: P1)

The operator enriches a repo and pays for the system prompt once per pack of chunks instead of once per chunk, cutting the bill ~3–4× while every chunk receives the same skills it would today.

**Why this priority**: This is the entire feature — the recall-safe cost cut. It delivers the saving the deterministic tiers couldn't, without touching what the model produces.

**Independent Test**: Enrich a repo with packing on; the model-call count drops to roughly chunk-count ÷ pack-size, the billed cost drops proportionally, and the per-chunk skills match the per-chunk baseline within the eval tolerance.

**Acceptance Scenarios**:

1. **Given** a repo of N chunks and pack size P, **When** enriched with packing, **Then** the number of model calls is roughly ⌈N/P⌉ (not N), and total enrichment cost falls by a large margin.
2. **Given** the same chunks, **When** enriched packed vs per-chunk, **Then** each chunk's skills are equivalent (recall ≥ baseline on the eval).

---

### User Story 2 - Results map back to the right chunk, unambiguously (Priority: P1)

Each chunk in a pack gets its own skills back, correctly attributed — never another chunk's skills, never silently dropped.

**Why this priority**: Packing is worthless (and dangerous) if a pack's results are misattributed across chunks. Correct per-chunk attribution is the core correctness property.

**Independent Test**: For a pack whose chunks have distinct expected skills, every chunk receives exactly its own skills; a response missing some chunks leaves those chunks unresolved (for fallback), not mis-mapped.

**Acceptance Scenarios**:

1. **Given** a pack of distinct chunks, **When** the model responds, **Then** each chunk is keyed to its own skills with no cross-contamination.
2. **Given** a response that omits or malforms some chunks' entries, **When** parsed, **Then** only the present, well-formed entries are applied and the rest are left for fallback (never guessed).

---

### User Story 3 - Opt-in, bounded, and fail-safe (Priority: P2)

The operator enables packing per run; it respects the model input budget; and any packing/parse failure falls back to per-chunk enrichment so a repo is never left under-enriched.

**Why this priority**: Lets the change ship dark and roll out safely, with the existing per-chunk path as the always-correct floor — secondary to having the capability.

**Independent Test**: Off → behaviour + cost identical to today. A pack exceeding the input budget is split. A forced parse failure on a pack re-enriches those chunks per-chunk.

**Acceptance Scenarios**:

1. **Given** packing disabled, **When** a repo is enriched, **Then** behaviour and cost match today's per-chunk enrichment exactly.
2. **Given** a pack whose combined content exceeds the input budget, **When** built, **Then** it is split into multiple within-budget packs (a single over-large chunk forms its own call).
3. **Given** a pack whose response fails to parse, **When** handled, **Then** those chunks are enriched per-chunk (fallback) and the failure is surfaced, not silent.

---

### Edge Cases

- A pack where one chunk is near-empty or boilerplate: it still gets its own (possibly empty) skill set; empty is valid, not a failure.
- Context-bleed: a chunk's skills must reflect ITS content, not skills bleeding from neighbours in the pack — this is the recall/precision risk the eval measures.
- A single chunk larger than the budget: forms its own call (degrades to per-chunk for that chunk; never dropped).
- The model returns more/fewer entries than chunks sent: extras ignored, missing chunks fall back; never positionally mis-aligned.
- Re-running enrichment stays idempotent and must not double-bill.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Enrichment MUST support grouping multiple chunks into a single model call that returns skills per chunk, so the shared system prompt is paid once per pack rather than once per chunk.
- **FR-002**: Each chunk in a pack MUST be individually read and judged by the model; the skills produced per chunk MUST be equivalent to today's per-chunk enrichment within the eval tolerance (cost-only, recall-preserving).
- **FR-003**: The packed response MUST attribute skills to each chunk unambiguously (keyed, not positional-by-luck); misattribution across chunks is a defect.
- **FR-004**: A malformed, short, or partial response MUST degrade safely — affected chunks fall back to per-chunk enrichment (never zero skills, never mis-mapped), and the failure MUST be surfaced.
- **FR-005**: Pack construction MUST respect the model input budget — a pack never exceeds it; an over-large single chunk forms its own call.
- **FR-006**: Packing MUST be opt-in; with it off, enrichment behaviour and cost are identical to today's per-chunk path.
- **FR-007**: Packed output MUST flow through the existing skill canonicalisation cascade, so skills remain canonical (the array-overlap retrieval lane is unaffected).
- **FR-008**: The feature MUST be guarded by an eval comparing packed-N output to per-chunk output on a labelled sample (recall + precision per chunk), run before packing is relied upon; no regression in recall.
- **FR-009**: Enrichment MUST remain idempotent and MUST NOT double-bill on re-runs.
- **FR-010**: The design MUST NOT preclude the composable follow-on levers (content-hash dedup cache; batch on the packed calls).

### Key Entities *(include if feature involves data)*

- **Chunk pack**: an ordered set of chunks grouped into one model call, bounded by the input budget; carries a stable per-chunk key for result attribution.
- **Packed enrichment result**: the model's per-chunk skill output, keyed back to each pack member; partial/malformed members fall back.
- **Pack outcome record**: per chunk, whether it was resolved by the pack or by per-chunk fallback (for cost/coverage measurement and the eval).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Model-call count for a repo's enrichment drops to roughly ⌈chunk-count ÷ pack-size⌉ — at pack size ~20–30, ~3–4× fewer calls than chunk count.
- **SC-002**: Total billed enrichment cost for a repo drops by a large margin — order-of-magnitude target ~$5.90 → ~$1.50–2.00, measured against the live baseline.
- **SC-003**: Per-chunk skill recall on the labelled eval is at least equivalent to the per-chunk baseline (no recall regression from context-bleed); precision does not fall.
- **SC-004**: Every chunk in a pack is attributed its own skills — zero cross-chunk misattribution on the eval sample.
- **SC-005**: With packing disabled, enrichment output is identical to today's per-chunk path (true no-op when off).
- **SC-006**: A forced pack failure still yields correct skills for every affected chunk via per-chunk fallback, with the failure visible in telemetry.

## Assumptions

- The existing enricher, skill resolver, controlled vocabulary, and the deferred-enrichment placement are reused; only the call grouping changes.
- "Equivalent skills" is judged against the existing per-chunk enrichment as the baseline on a labelled sample (semantic, post-canonicalisation), not exact-string identity.
- Pack size is a tunable bounded by the model's input/output budget; the default is chosen so a typical pack fits comfortably and is validated by the eval.
- The structured per-chunk output uses the model's structured-output capability already used by the per-chunk enricher, extended to an array keyed by chunk.
- Dedup cache + batch are explicitly out of scope here (follow-on recall-safe levers) but the design leaves room for them.
- Baseline figures (~$5.90/repo, 3,932 chunks, ~700-token system prompt) are measured on the live dev system, used only as the comparison point.
