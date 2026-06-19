# Contract: Skill Vocabulary Importer

The skill importer is an internal K8s Job (no public API). Its contracts are the
**Job invocation surface** and the **source port** the new sources implement.

## Job: `run-skill-import`

Runs `dist/run-skill-import.js` in the `ontology-importer` image (mirrors the
existing `run-import` Job).

### Environment

| Var | Required | Meaning |
| --- | --- | --- |
| `PG_HOST` / `PG_PORT` / `PG_DATABASE` / `PG_USER` / `PG_PASSWORD` | yes | RDS connection (reference data — no userId/RLS) |
| `AWS_REGION` (or `AWS_DEFAULT_REGION`) | yes | Bedrock (Titan backfill + Haiku batch categorisation) |
| `ONET_BUNDLE_URL` | yes | O*NET database bundle location (CC-BY) |
| `SKILL_IMPORT_SOURCES` | no | comma list to limit sources (default: all) — `onet,curated` |
| `SKILL_IMPORT_MAX` | no | hard cap on canonicals written this run (cost/safety guard) |
| `DEDUP_AUTO_MERGE_THRESHOLD` | no | cosine ≥ → auto-merge (default 0.85) |
| `DEDUP_REVIEW_FLOOR` | no | cosine ≥ → review queue (default 0.70) |
| `DRY_RUN` | no | when `1`, fetch + categorise + log counts, **write nothing** |

### Behaviour

1. Fetch each enabled source through the **capped-fetch helper** (timeout + max-byte cap).
2. Categorise each `RawImportEntry` into one of the 15 skill categories (L1–3 deterministic → L4 Haiku batch).
3. Reject any entry whose `source_licence` is not on the approved allowlist (`CC-BY-4.0`, `curated`).
4. Upsert canonicals + aliases idempotently (`SkillOntologyWriteRepository`), recording `source`, `source_licence`, `source_url`; curated rows are never overwritten by an import (FR-008).
5. De-duplicate: auto-merge ≥ `DEDUP_AUTO_MERGE_THRESHOLD`; queue `[REVIEW_FLOOR, AUTO_MERGE)` for human review.
6. Call `backfillSkillEmbeddings` to embed the new `embedding IS NULL` canonicals.
7. `finish()` the import run with `ImportRunCounts`.

### Exit codes

- `0` — import completed (counts recorded; per-entry skips are non-fatal + queued/logged).
- `1` — fatal: bad env, DB unreachable, source bundle unreachable after retry, or a write transaction failed.

### Idempotency contract (FR-005, SC-004)

Re-running with the same source bundle MUST leave the canonical count unchanged (no duplicates) and embed zero new vectors. Verified by the quickstart re-run check.

## Source port: `SkillSource`

New sources implement the existing generic `Source` interface (reused from the technology importer):

```ts
interface SkillSource {
    readonly name: string;          // 'onet' | 'curated'
    readonly licence: string;       // 'CC-BY-4.0' | 'curated'  (allowlist-checked)
    fetch(): AsyncIterable<RawImportEntry>;  // capped-fetch internally
}
```

- `RawImportEntry` is reused unchanged (`proposed_canonical_name` lowercased, `proposed_display_name`, `keywords`, `source_metadata`, …).
- `licence` is surfaced so the importer can reject a misconfigured source before any write.
