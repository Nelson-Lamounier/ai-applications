# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Categories: **Added** (new features), **Changed** (changes to existing behaviour),
**Deprecated**, **Removed**, **Fixed** (bug fixes), **Performance**, **Security**.

## [Unreleased]

### Added
- RAG retrieval evaluation harness: golden query set + TS-native LLM judge
  (context-relevance, recall@k, negative-control leakage), with results persisted
  to RDS (`rag_eval_runs` / `rag_eval_results`) for Grafana trend panels.
- Pluggable offline scorers: DeepEval and RAGAS harnesses over the same JSONL,
  plus a Bedrock-Evaluations BYOI converter/importer — all writing to the shared
  eval tables.
- Ingestion run classification (`initial` / `full_reindex` / `incremental`),
  surfaced as the `ingestion_runs_total{sync_type}` metric and
  `repo_sync_state.last_sync_type`.
- Re-enrich backfill Job that fills deferred / over-cap chunk skills off the
  critical path; per-run enrichment cap raised.
- KB retrieval hygiene (tooling-doc exclusion + raw-cosine floor) and
  score-aware interview coaching.
- Application-analytics schema (migrations 067–068): per-stage outcome and
  user-feedback capture.
- ATS-quality scoring embedded in JD-driven résumé generation; pre-final-interview
  and bar-raiser coach stages.

### Performance
- Fast first scan: enrichment deferred to an in-job background pass so a repo is
  searchable in minutes; the GitHub file tree is fetched once and reused.
- Chunk upserts collapsed into multi-row `INSERT`s (~2400 round-trips → ~12 for a
  2.4k-chunk repo).

### Fixed
- Strip NUL (`0x00`) from chunk text before upsert — Postgres `TEXT` rejects it,
  which previously dropped the offending chunk on the per-row fallback.
- Await Bedrock cost recording before the connection pool closes.
- CI: run `job-strategist` ATS/render tests in their own workspace; declare
  `jest`/`ts-jest` as devDependencies.

## [0.1.0] - 2026-05

### Added
- Initial Bedrock multi-agent platform: GitHub repository ingestion + chunking,
  Titan v2 embeddings into RDS `pgvector`, hybrid retrieval, and the
  job-strategist / article-pipeline / resume-import pipelines.

[Unreleased]: https://github.com/Nelson-Lamounier/ai-applications/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Nelson-Lamounier/ai-applications/releases/tag/v0.1.0
