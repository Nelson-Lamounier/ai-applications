# Feature Specification: Enrichment Cost Reduction

**Feature Branch**: `feat/enrichment-cost-reduction`

**Created**: 2026-06-19

**Status**: Draft

**Input**: User description: "Reduce the cost of chunk skill-enrichment via per-file granularity + batch inference, cost-only (skills must be equivalent), proven by a per-phase eval."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Re-enriching the corpus is cheap enough to run routinely (Priority: P1)

The operator updates the skill vocabulary (or changes the resolver) and wants to re-apply it across the whole corpus. Today that means one model call per chunk — ~12,000 calls and ~$12 for a full re-enrich — expensive enough that the operator defers it. With per-call cost cut substantially, the operator re-enriches the corpus on demand without weighing the cost.

**Why this priority**: This is the entire purpose — enrichment cost is the friction that makes operators defer rollouts. Cutting it unblocks routine re-enrichment of the corpus after every vocabulary change.

**Independent Test**: Re-enrich a repository the cheap way and the current way, and compare the billed enrichment cost; the cheap path must be a large fraction lower.

**Acceptance Scenarios**:

1. **Given** a repository whose chunks belong to far fewer distinct files than chunks, **When** it is enriched the new way, **Then** the number of model calls is materially lower than the chunk count (bounded by file/symbol count, not chunk count).
2. **Given** the same repository, **When** enriched the new way vs the old way, **Then** the total billed enrichment cost is reduced by a large margin.

---

### User Story 2 - Enriched skills are equivalent to today (Priority: P1)

The operator must trust that cheaper enrichment does not silently degrade the product. The skills attached to chunks — and therefore retrieval and résumé matching — must be equivalent to today's per-chunk enrichment.

**Why this priority**: Equal priority to the cost win, because a cost saving that quietly drops skill recall or mis-tags chunks is a regression, not an optimisation. This is the guard that makes the cost change safe.

**Independent Test**: Run the enrichment eval comparing the new path's skills against the per-chunk baseline on a labelled sample; recall must not drop and precision must not fall (no chunk tagged with a skill it does not evidence).

**Acceptance Scenarios**:

1. **Given** a labelled sample of chunks, **When** enriched the new way, **Then** skill recall is at least equivalent to the per-chunk baseline.
2. **Given** a file whose skill appears in only some of its chunks, **When** enriched at file granularity, **Then** a chunk is NOT tagged with a skill that file-level extraction attributed elsewhere but that the chunk does not evidence (precision preserved).

---

### User Story 3 - The cheap path is opt-in and safe to fail (Priority: P2)

The operator can enable the cheaper enrichment per run, and if any part of it fails the run falls back to producing correct skills rather than failing or producing none.

**Why this priority**: Lets the cost change ship behind a switch and roll out gradually, with the existing per-chunk path as the always-correct fallback — secondary to having the capability at all.

**Independent Test**: Disable the cheap path → enrichment behaves exactly as today. Enable it and force the batch/file step to fail → the run still completes with correct skills via fallback.

**Acceptance Scenarios**:

1. **Given** the cheap path is disabled, **When** a repo is enriched, **Then** behaviour and cost match today's per-chunk enrichment exactly.
2. **Given** the cheap path is enabled and its batch step fails, **When** the run completes, **Then** chunks still receive correct skills (fallback), and the failure is surfaced, not silent.

---

### Edge Cases

- A file with a single chunk: per-file granularity must not cost more than per-chunk (degrade gracefully to one call).
- A very large file whose concatenated content exceeds the model input budget: the file is split into bounded units so no call is over-sized.
- A chunk whose skills genuinely differ from its file's other chunks (e.g. a big multi-purpose file): the design must not over-propagate skills it cannot evidence (this is the precision risk the eval gates).
- The asynchronous batch step is delayed or partially fails: the run must still converge to correct skills (fallback) within the operator's time budget.
- Re-running enrichment must remain idempotent and must not double-bill.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Enrichment MUST extract skills at a coarser granularity than per-chunk (per file, or per code symbol where structural parsing already exists), and propagate the result to the chunks that belong to that unit, so the number of model calls is bounded by unit count rather than chunk count.
- **FR-002**: Enrichment MUST support submitting the model calls as an asynchronous batch for a reduced per-call rate, for the calls that remain after the granularity reduction.
- **FR-003**: The cheaper enrichment MUST be cost-only: the skills produced (and therefore retrieval + résumé matching) MUST be equivalent to today's per-chunk enrichment, within the eval tolerance.
- **FR-004**: Per-file propagation MUST NOT tag a chunk with a skill it does not evidence — a skill attributed at file level is only applied to chunks whose content supports it (precision guard).
- **FR-005**: The feature MUST be guarded by a per-phase eval that compares the new path against the per-chunk baseline on a labelled sample, run before the path is relied upon; it MUST report recall and precision and gate on no regression.
- **FR-006**: The cheaper path MUST be opt-in (a run-level switch); with it off, enrichment behaves and costs exactly as today.
- **FR-007**: The cheaper path MUST be fail-safe: any failure of the granularity or batch step falls back to producing correct skills (never zero skills, never a failed run), and the failure MUST be surfaced, not swallowed.
- **FR-008**: Enrichment MUST remain idempotent and MUST NOT double-bill on re-runs.
- **FR-009**: The existing skill resolver, canonical vocabulary, and corpus re-enrich rollout path MUST be unchanged by this feature — it changes only how the enricher groups and submits its model calls.

### Key Entities *(include if feature involves data)*

- **Enrichment unit**: the grouping a single model call covers — a file or a code symbol — comprising one or more chunks. Replaces the chunk as the unit of a model call.
- **Skill attribution**: the mapping from an enrichment unit's extracted skills down to its member chunks, subject to the per-chunk evidence guard (FR-004).
- **Batch job**: an asynchronous submission of many enrichment-unit calls, with a result-collection + fallback path.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Model-call count for a repository's enrichment drops to roughly its distinct-file (or symbol) count rather than its chunk count — on the reference repo that is ~1,066 vs 3,932, a ~3.7x reduction.
- **SC-002**: Total billed enrichment cost for a large-repo rebuild drops by a large margin — order-of-magnitude target ~$5.46 → ~$0.74, measured against the live baseline.
- **SC-003**: Skill recall on the labelled eval sample is at least equivalent to the per-chunk baseline (no recall regression).
- **SC-004**: Precision on the eval sample does not fall — zero chunks tagged with a skill they do not evidence beyond the per-chunk baseline's rate.
- **SC-005**: With the cheaper path disabled, enrichment output is byte-for-byte equivalent to today's per-chunk path (true no-op when off).
- **SC-006**: A forced failure of the batch/file step still yields correct skills for every chunk (fallback), with the failure visible in telemetry.

## Assumptions

- The structural parser already run during ingestion (tree-sitter) can supply file/symbol boundaries for grouping; no new parser is introduced.
- The asynchronous batch mechanism offers a meaningful per-call discount and is acceptable latency-wise for a background/maintenance enrichment job (not the user request path).
- Prompt caching is NOT a lever here (the static prefix is far below the model's minimum cacheable size) and is out of scope.
- The two levers (granularity, batch) are independent and may ship/measure separately; granularity is the larger lever and the one needing the precision eval.
- "Equivalent skills" is judged against the existing skill-resolution eval harness + a per-chunk-vs-per-file comparison on a labelled sample, not exact string identity (the resolver already canonicalises).
- The reference cost figures ($5.46/large repo, ~12k corpus calls) are measured on the live dev system, used only as the comparison baseline.
