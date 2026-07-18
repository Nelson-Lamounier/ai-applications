---
title: Deterministic extraction replaces LLM ChunkEnricher for technologies
type: decision
tags: [bedrock, llm, ontology, finops, architecture]
sources:
  - applications/ingestion/docs/tech-extractor/parity/2026-05-27-decommission.md
  - applications/ingestion/docs/tech-extractor/parity/2026-05-26-analysis.md
  - applications/ingestion/src/facts/extractors/
  - applications/shared/src/rds/implementations/BedrockChunkEnricher.ts
created: 2026-05-27
updated: 2026-05-27
---

## Status

Accepted — landed 2026-05-27 (commit `69eae87 feat(ingestion): decommission BedrockChunkEnricher technologies extraction`).

> **Note (2026-07-18):** the extractors this ADR describes lived in a
> standalone `applications/tech-extractor/` service at acceptance time.
> That service has since been retired and folded into
> `applications/ingestion/src/facts/` (see
> [docs/projects/tech-extractor.md](../projects/tech-extractor.md) for
> the retirement note). Source links below have been updated to the
> current paths; the decision itself is unchanged.

## Context

`BedrockChunkEnricher` was the original source of `technology_evidence`
rows for the ingestion pipeline: each document chunk was sent to Bedrock
with a system prompt + tool schema asking the model to extract both
`skills` and `technologies`. The output populated
`document_embeddings.skills` and `document_embeddings.technologies`.

Three pressures converged:

1. **Cost.** The LLM tool schema carried two extraction properties on
   every chunk for every ingested repository. The platform's KB grows
   monotonically; this cost grows with it.
2. **Determinism.** Tech-graph downstream consumers
   (`computeKbQuality`, ontology-importer, projects clustering) want
   reproducible token sets — two ingestions of the same source should
   produce the same evidence. LLM extraction does not guarantee that.
3. **An incremental engineering path existed.** Static-analysis primitives
   in `applications/ingestion/src/facts/extractors/` (Tree-sitter
   comment scanner, IaC YAML/Dockerfile/Terraform/Helm parsers, README
   prose parser) were already in place for a separate use case
   (repository-profile signals). A "promote them to be the canonical
   source for technologies" path was viable.

The measurement engagement ran from "pre-ReadmeParser v2" (KBS recall
0.368, TUC 0.253, ~100 LLM-only canonicals) through six iterations to
v2.4
([applications/ingestion/docs/tech-extractor/parity/2026-05-27-decommission.md](../../applications/ingestion/docs/tech-extractor/parity/2026-05-27-decommission.md)):

| State | KBS recall | TUC recall | LLM-only canonicals |
| :- | -: | -: | -: |
| Start | 0.368 | 0.253 | ~100 |
| v2.0 — ReadmeParser v2 (PR #56) | 0.529 | 0.266 | 98 |
| v2.1 — F1 IaC value scanner (PR #59) | 0.575 | 0.519 | ~75 |
| v2.3 — F3 YAML-comment prose (PR #64) | 0.624 | 0.510 | 89 |
| v2.4 — F4 bigram + negation (PR #66) | 0.673 | 0.548 | 80 |
| Target gate | ≥ 0.85 | ≥ 0.65 | ≤ 10 |

Target gates were not met. 80 canonicals remained that the LLM was
emitting and the deterministic pipeline was not. The temptation was to
treat that as proof the LLM was still pulling its weight and keep it
running.

## Decision

**Decommission the `technologies` extraction role of `BedrockChunkEnricher`
as of 2026-05-27.** The deterministic `tech-extractor` Layer-1 pipeline
is the sole source of truth for `technology_evidence` going forward.

Specific code changes
([decommission artefact §3](../../applications/ingestion/docs/tech-extractor/parity/2026-05-27-decommission.md)):

- `BedrockChunkEnricher.SYSTEM_PROMPT` no longer instructs the model
  to extract technologies.
- `BedrockChunkEnricher.TOOL_SCHEMA` removes the `technologies`
  property; only `skills` remains.
- `BedrockChunkEnricher.enrich()` returns `technologies: []`
  unconditionally for schema back-compat with
  `document_embeddings.technologies` (column retained; values empty
  going forward).
- The skills extraction role is **unchanged** — no structural
  alternative exists for skills today, and `computeKbQuality` /
  `computeUserDiagnostic` consume the field.
- `technology_parity_runs` keeps running as a watchdog. Going forward
  `llm_canonical_count = 0` and `recall` is undefined; the row's
  presence is the audit trail showing when decommission landed.

## Consequences

**Enabled:**

- **Per-chunk token spend drops ~30-50% output / ~10% input.** The tool
  schema dropped from 2 properties to 1; the system prompt shortened
  ([decommission artefact §3](../../applications/ingestion/docs/tech-extractor/parity/2026-05-27-decommission.md)).
- **Reproducible technology evidence.** Same repository ingested twice
  yields identical `technology_evidence` rows. Downstream clustering and
  KB-quality scoring becomes deterministic.
- **Clearer ownership.** The tech-graph has one source of truth
  (`tech-extractor` Layer 1) instead of two competing ones merged at
  query time.
- **Quantified residual.** The 80 LLM-only canonicals are documented in
  `2026-05-27-bucket-recount-v23.csv` and `2026-05-26-diff-classification.csv`.
  Any downstream consumer noticing a gap can quote a CSV row, not a hunch.

**Prevented:**

- Closing the recall gap by "just keep the LLM running." Once the LLM
  is wired back in, two evidence streams exist again and the
  reproducibility argument collapses.
- Letting a black-box capability quietly remain authoritative for a
  field other systems take as ground truth.

**New problems / accepted residual:**

- **80 canonical-bucket gap remains.** Predominantly multi-word AWS
  service phrases in prose (`AWS Bedrock`, `Step Functions`, `API
  Gateway`) and single-token identifiers (`bash`, `curl`, `jwt`,
  `cors`, `pino`, `vite`, `yarn`) judged ambiguous by the original
  ProseSafeTagger run
  ([decommission artefact appendix](../../applications/ingestion/docs/tech-extractor/parity/2026-05-27-decommission.md)).
- **Skills extraction still depends on the LLM path.** A future
  decommission would require either a deterministic skills extractor
  (no obvious design) or accepting the LLM cost for skills only.

## Alternatives considered

### Keep the LLM running and treat tech-extractor as augmentation

The dominant default. Rejected because it leaves two competing
evidence streams and forfeits reproducibility. The platform's signal
already pays the cost of merging at query time. Adding parser-derived
evidence on top of LLM-derived evidence would compound that, not fix it.

### Push harder on the parser until target gates are met

The engagement *was* this path, for six iterations. Final closure
plateaued at v2.4 — not because parsers plateaued, but because the
residual is single-token identifiers whose `prose_safe` classification
is a judgement call per token. Each further token requires manual
calibration; the marginal cost of each new percentage point of recall
grew faster than the operational pain of the carve-out.

### Hybrid — LLM only for prose, parsers for IaC/code

Considered briefly. Rejected because the boundary "what counts as
prose" is itself fuzzy (READMEs, code comments, YAML comments are all
prose-like) and the F2 + F3 + F4 work demonstrated the parser path
handles each of them. A hybrid would re-introduce the two-stream
problem without removing the LLM-cost problem.

### F4 — multi-word phrase scanner (now landed as PR #66)

Was on the table as a way to close the bucket-a gap (~50 of the v2.3
residual). Landed during the engagement as the appendix work. Took
recall to 0.673 / 0.548, still short of gates, but cut LLM-only from
89 → 80 and demonstrated zero false positives across 30 sampled
bigram rows (or 10% counting borderlines like `aws_profile`)
([decommission artefact appendix](../../applications/ingestion/docs/tech-extractor/parity/2026-05-27-decommission.md)).
F4 shipped because it was incremental, measurable, and reversible —
not because it would unblock the decision.

## How this relates to the self-healing agent

The converse decision. See
[self-healing-agent concept doc](../concepts/self-healing-agent.md).
Where this ADR removes an LLM from a path that had a deterministic
alternative, the self-healing agent *adds* an LLM where the
alternative is brittle hand-coded runbooks. The pair demonstrates the
heuristic both decisions rest on: **reach for the LLM when the input
is unstructured and the action space is open; reach for a parser when
the input is structured and the output must be reproducible**.

<!--
Evidence trail (auto-generated):
- Source: applications/ingestion/docs/tech-extractor/parity/2026-05-27-decommission.md (read on 2026-05-27)
- Source: applications/ingestion/docs/tech-extractor/parity/2026-05-26-analysis.md (referenced)
- Source: applications/ingestion/src/facts/extractors/ (directory listing on 2026-05-27)
- Commit: 69eae87 feat(ingestion): decommission BedrockChunkEnricher technologies extraction
- Commit: d1e6f34 feat(tech-extractor): F4 prefix-guarded bigrams + negation detection (PR #66, post-decommission appendix)
-->
