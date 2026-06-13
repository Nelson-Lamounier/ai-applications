<!-- @format -->

# Evidence Provenance & Data-Quality Strategy

**Goal.** Make it observable, and storable over time, *what the research and coach/strategist
agents actually query and use from the ingested repository data* — so we can verify the
synced/resynced extraction is correct and fit-for-JD, and drive ingestion improvements. The
`self_hosted_kubernetes / kubeadm` doc-vs-code drift (PR #197) is the motivating case: it was
invisible until reactively found.

## What already exists (per `pipeline_runs.metadata.research`)

A lot of provenance is captured, but trapped in a ~92 KB JSONB blob and not queryable across runs:

- `kbRetrievalStats` — `passageCount`, `floor`, `max/median/minCosine`, `topSources` (file + cosine),
  `repoBreakdown` (per-repo passage counts).
- `kbContext` — every retrieved passage annotated `[Source: owner/repo/file, Cosine, Rerank]`.
- `verifiedMatches` / `partialMatches` / `gaps` with `evidenceFiles`; the `skillEvidenceLedger`.
- Deterministic guard outputs (logs): vendor-provenance demotions, code-truth contradictions.

What is **missing**: cross-run queryability, per-passage **usage attribution** (retrieved → cited →
demoted), and per-repo **data-quality trends** over time.

## Architecture

Instrument the three hops — **ingest → retrieve → use** — into queryable RDS tables (joinable to
`pipeline_runs` and `technology_evidence`), surfaced via the existing Grafana `rds-postgres`
datasource + Prometheus, closing the loop back to ingestion.

### Phase 1 — Provenance store (foundation)

Append-only table **`evidence_provenance`**, one row per (run, retrieved passage):

| column | meaning |
|---|---|
| `pipeline_run_id`, `user_id`, `created_at` | run scope |
| `target_role`, `target_company` | JD scope (trend by role) |
| `agent` | `research` \| `coach` |
| `repo_full_name`, `file_path` | where the evidence came from |
| `cosine`, `rerank`, `passed_floor` | retrieval quality |
| `usage_status` | `retrieved` \| `cited_verified` \| `cited_partial` \| `demoted` |
| `demotion_reason` | `vendor_provenance` \| `code_truth` \| `null` |

Written at end of each run by flattening data already in `metadata` + the guard outputs. Captures
**both retrieved and used** evidence, so retrieved-but-never-cited passages (dead KB) are visible.

### Phase 2 — Per-repo data-quality rollup

Table **`repo_evidence_quality`** (per user+repo, per run/ingest): `passages_ingested`,
`passages_ever_cited`, `cite_rate`, `drift_count`, `stale_files[]`, `jd_tools_requested/matched/gap`,
`extraction_confidence_dist`, `last_synced_at` vs `last_code_commit`. The "is the extracted data
correct & fit-for-JD" signal — cdk-monitoring's stale docs become a standing `drift_count`.

### Phase 3 — Dashboards + alerts (Grafana / Prometheus)

Per-run evidence trace; a "stale & demoted" board (drift, vendor mis-attribution, **never-cited
chunks**); per-repo quality trends; JD-coverage gaps (requested tech with no evidence).

### Phase 4 — Closed loop to ingestion

A periodic reconciliation job runs the code-truth check across **all** repos (not just at JD time),
writes drift to `repo_evidence_quality`, prioritises resync / re-extraction of stale, low-cite, or
low-confidence repos, and surfaces extraction **gaps** (JD-relevant tech the extractor missed).

## Decisions

- **Storage:** dedicated append-only RDS tables (queryable, time-series, joinable) — not more JSONB.
- **Granularity:** per-passage trace (all retrieved) + usage attribution — richest signal for
  improving ingestion; ~50 rows/run is cheap.

## Status

- Phase 1 — in progress.
- Phases 2–4 — planned.
