# Data Model: Chunk-Packing for Enrichment

**Date**: 2026-06-19 | **Feature**: 004-chunk-packing

No schema change. The cascade writes the same `document_embeddings.skills` it does today. Shapes below are in-memory.

## In-memory shapes

### PackItem (input to packing)
| Field | Type | Notes |
|---|---|---|
| `key` | `string` | stable per-chunk id (db id, or `filePath::chunkIndex`) — the attribution key |
| `filePath` | `string` | for the labelled block + provenance |
| `content` | `string` | the chunk text the model judges |
| `heading` | `string?` | optional section context |

### ChunkPack (output of `packChunks`)
| Field | Type | Notes |
|---|---|---|
| `items` | `PackItem[]` | ≤ `ENRICH_PACK_SIZE`, combined content ≤ `ENRICH_PACK_MAX_CHARS` |

**Rules**: greedy fill to either bound; a single item over the char budget forms its own pack (one-item pack, never dropped). Deterministic, pure.

### PackedExtraction (the model's per-chunk output, parsed)
| Field | Type | Notes |
|---|---|---|
| `key` | `string` | echoes a PackItem key |
| `skills` | `string[]` | raw (pre-canonicalisation) skills for that chunk |

**Rules (FR-003/004)**: parsed into `Map<key, skills>`; keys not present in the response are MISSING → per-chunk fallback; keys not requested are ignored. Never positional.

### PackOutcome (per chunk, for measurement)
- `resolvedBy: 'pack' | 'per-chunk-fallback'` — drives SC-001 (call reduction) + SC-006 (fallback) reporting.

## Invariants
- Packed skills flow through the SAME canonicalisation cascade as per-chunk (FR-007) — canonical-only output, overlap lane unaffected.
- A chunk's skills derive from ITS content (FR-002) — the eval guards against context-bleed.
- Off (`ENRICH_PACK` unset) → byte-for-byte today's per-chunk path (FR-006/SC-005).
- One cost record per packed call (FR-009) — accurate per-repo telemetry, no double-bill.
