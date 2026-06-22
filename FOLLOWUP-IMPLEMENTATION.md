<!-- @format -->

# Follow-up implementation backlog

Running list of follow-up ideas captured from the RAG / ingestion / tech-extractor
review sessions. Each item has enough context + grounding to act on later. Add
new items under "Backlog" as they come up.

---

## 1. Pure-lazy ("enrich-on-first-use") enrichment

**Idea:** make chunk-skill enrichment a *future optimization* that only enriches
the repos of users who actually engage, instead of eagerly enriching every
ingested repo.

> The pure-lazy variant is a legitimate future optimization (only enrich repos
> of users who actually engage), and the `pending` status + `reenrichSkippedChunks`
> machinery is already most of what you'd need to build it.

### Why it's valid
- `skills` enrichment is the **bulk of a run's cost** (e.g. ai-applications:
  ~3,652 `chunk-enrich` Haiku calls ≈ **$5** per full reindex).
- If a user never runs a JD or builds a project, that spend was wasted — the
  `skills` index is only paid off when something *queries* the KB.
- So: defer the spend until the first query that needs it, rather than at ingest.

### What already exists (most of the machinery)
- Chunks can be marked `metadata.enrichment_status = 'pending'` (the pipeline
  already does this in defer mode).
- `reenrichSkippedChunks` (applications/ingestion/src/util/reenrichSkippedChunks.ts)
  selects `enrichment_status IN ('skipped_quota','pending')`, enriches in place,
  flips to `'ok'` — idempotent, resumable, now with a time budget (`deadlineMs`).
- So the "warm the cache when needed" primitive is already built.

### What you'd add to make it pure-lazy
- **Stop eager enrichment at ingest** (or gate it behind a per-user "active"
  flag) so chunks land as `pending` and stay that way until used.
- **Trigger enrichment on first engagement** — when a JD run / project build /
  chatbot query first touches a user's KB, kick `reenrichSkippedChunks` for that
  `userId` (+ optionally just the repos involved) before/around retrieval.
- **Decide the latency model:** block the first query until enrichment of the
  relevant slice finishes (slow first query, correct results), or return
  vector-only results immediately and back-fill (fast but lower first-query
  recall on capability queries).

### Trade-off to weigh
- **Eager (today):** predictable cost at ingest, off the user's critical path;
  pays for dormant users.
- **Pure-lazy:** no spend on dormant users; first engaging query is slower / has
  unpredictable latency, and needs careful scoping (which repos to enrich, how
  much, under what time budget).

### Key reframe (so the design stays honest)
`skills` is a **retrieval index consumed by SQL** (`d.skills && $query`), NOT
LLM input — the JD/project LLM never reads it; it reads the *retrieved content*.
So "lazy + cache per user" converges to exactly today's stored `skills` column;
the only real variable is **when** you pay and whether the first query waits.

---

## 2. Retire the tech-extractor parity read (dead `document_embeddings.technologies`)

**Idea:** the tech-extractor still reads the now-permanently-empty
`document_embeddings.technologies` column to compute an L1-vs-LLM parity metric.
That comparison has been meaningless for ~3 weeks (the LLM stopped writing
`technologies` on 2026-05-27); retire the read.

> Removing this touches a Prometheus recall gauge + a parity table (possibly on a
> dashboard), so I don't want to rip it out unilaterally. Want me to retire the
> parity read (it's been comparing against empty for 3 weeks — meaningless), or
> leave it? The empty column itself I'd leave (dropping a DB column needs a
> migration for zero benefit). Say the word and I'll do the parity cleanup as a
> small PR.

### Context / grounding

- Reader: `applications/tech-extractor/src/run-tech-extract.ts:~189` —
  `SELECT DISTINCT unnest(technologies) FROM document_embeddings …` → `llmTechs`.
- The enricher decommissioned `technologies` on 2026-05-27
  (`BedrockChunkEnricher.ts:56-60`, schema is skills-only, `technologies: []`
  hardcoded). Live data confirms: **0 rows** have `technologies` populated.
- So `computeParity(resolver, result.canonicalIds, llmTechs)` runs with
  `llmTechs = []` → the `recall` gauge + `parityRepo.insert(...)` are degenerate.
- The real tech signal lives in `technology_evidence` (deterministic
  tech-extractor; 3,915 rows for ai-applications), read by projects/case-study,
  coach stage-prep, JD/applications, canonical ontology, and the KB UI.

### Decision needed (blocks the small PR)

- **Retire** the parity read + its `recall` gauge + `parityRepo.insert` (clean,
  but check no dashboard/alert depends on the gauge first), **or**
- **Leave it** (non-fatal, just emits a meaningless `recall≈0`).

### Explicitly NOT doing

- Dropping the `document_embeddings.technologies` **column** — needs a migration
  for zero benefit; leave it as a dead/empty back-compat column.

---

## 3. Standardise the tech-extractor (formats + reuse standard libs)

**Idea:** keep the architecture (deterministic, multi-source, file-cited → canonical
ontology — that's the defensible value) but swap ad-hoc lanes for industry-standard
libraries/formats so it interoperates with the SBOM/vuln/provenance ecosystem.
Verified against current docs (June 2026). **Net new SaaS cost ≈ $0** — these are
OSS libs + free formats/APIs; the spend is engineering time.

### Per-lane decision (keep / replace / augment)

| Lane (today) | Decision | Standard to adopt | Why / cost |
| --- | --- | --- | --- |
| **Syft** (deps SBOM) | **KEEP** | emit **CycloneDX 1.6 JSON** (Syft does natively) as the interchange format | Syft is THE OSS standard (30+ ecosystems); CycloneDX is the security/automation + EU-CRA format. Cost: ~0 (a flag). Don't *replace* Syft with GitHub's API (below). |
| GitHub **SBOM API** | **ADD as free fallback/cross-check** | `GET /repos/{o}/{r}/dependency-graph/sbom` → SPDX JSON | Free, **no compute** (one API call, needs read access). BUT: no transitive deps, drops Go `v` prefix, leaves version ranges verbatim, GitHub-hosted repos only → **not** a primary replacement for Syft. Good for a zero-compute cross-check or when Syft is overkill. |
| **tree-sitter** (AST imports) | **KEEP** | optionally **SCIP** (SourceGraph) if cross-repo symbol graphs ever needed | already standard. |
| **code-prose / readme** lanes (language guessing) | **REPLACE with** | **`go-enry`** (Go port of GitHub Linguist, ~2× faster, embeddable lib; tracks linguist v9.5.0) | the standard language detector; removes ad-hoc detection. Cost: ~0 (fast lib). |
| **IaC parsers** (Docker/K8s/TF/Helm, custom) | **EVALUATE replace/augment** | **Trivy** config parsers (also parse the same files, maintained) | reduces custom-parser maintenance; Trivy is security-focused so weigh fit. Cost: +1 binary/runtime. |
| **canonical ontology + resolver** (custom) | **KEEP, augment key** | **PURL (Package URL)** as the canonical identifier; cross-ref **ecosyste.ms / libraries.io** | PURL is the SBOM-standard id (CycloneDX + SPDX both use it) → clean cross-repo dedup/aggregation + interop. The hiring/skill ontology stays custom (no off-the-shelf equiv). |
| (former LLM `technologies`) | **already dropped** 2026-05-27 | — | no LLM cost in tech-extractor. |

### Recommended target

- **Interchange format:** **CycloneDX 1.6 JSON** as the canonical output (keep
  `technology_evidence` internally for the file-cited/skill model, but map to/from
  CycloneDX). Biggest single standards win — unlocks Grype/Dependency-Track/vuln +
  provenance tooling for free.
- **Canonical key:** **PURL** for package identity across ecosystems.
- **Language lane:** **go-enry**. **Deps:** Syft (primary) + GitHub SBOM API (free fallback).
- **Future / provenance:** signed SBOMs + **SLSA / in-toto** attestation if
  "provable evidence for recruiters" becomes a hard product promise.

### Scalability notes

- Already per-repo + parallel (separate Job) — good. PURL keys make cross-repo
  aggregation/dedup clean; CycloneDX makes the output ecosystem-interoperable;
  GitHub SBOM API offloads compute for huge dep trees (no Syft run).
- Migration is **incremental + low-risk**: adopt one lane at a time behind the
  existing `source_layer` model; the schema already carries `ecosystem` +
  `source_layer`, so adding a `purl` column + a CycloneDX exporter is additive.

### Sources

- [GitHub SBOM REST API](https://docs.github.com/en/rest/dependency-graph/sboms) — SPDX JSON, read access, ~1wk retention
- [SBOM tool comparison](https://sbomify.com/2026/01/26/sbom-generation-tools-comparison/) — Syft leads OSS, 30+ ecosystems
- [Syft vs GitHub dep-graph accuracy](https://www.deepbits.com/blog/BreakingDownTheAccuracyOfSBOMGenerators) — transitive/version-range gaps
- [CycloneDX vs SPDX](https://sbomify.com/2026/01/15/sbom-formats-cyclonedx-vs-spdx/) — security vs compliance; CycloneDX for automation/CRA
- [go-enry](https://github.com/go-enry/go-enry) — Linguist port, ~2× faster, embeddable

---

## 4. Extend the deterministic-provenance pattern to RAG ingestion (epic, 5 slices)

**Principle (from the architecture review):** don't SBOM-ify the RAG KB — CycloneDX
is a software-supply-chain format, wrong domain for chunks/embeddings. Port the
*patterns* the tech-extractor proved (file-cited provenance, canonical resolution,
lineage) onto the ingestion side, and target the **RAG-domain** standards. Keep the
split: deterministic structure + provenance as the backbone, LLM judgment layered on.

### Slices

1. **Line ranges on chunks** — ✅ DONE (this work). `CodeChunker` emits
   `metadata.lineStart`/`lineEnd` (1-based inclusive), auto-persisted to
   `document_embeddings.metadata`. Enables citable retrieval ("see file.ts:42-87").
   *Follow-up:* do the same in the line-window `DefaultChunker` for non-code files.
2. **Canonical skill resolution** — ✅ DONE. `skill_ontology` + `skill_aliases`
   (migration 092) + `SkillOntologyRepository` reusing the generic `OntologyResolver`
   (2a, PR #275); write-path wiring in `BedrockChunkEnricher.normalize` across
   inline/deferred/re-enrich (2c, PR #276); vocabulary from `role_ontology` +
   curated capability batch (2b, PR #277). `"k8s networking"` ≈ `"kubernetes
   networking"` now collapse deterministically. *Vocabulary is curated in-house —
   see backlog "align skill/role ontology to an external taxonomy".*
3. **Embedding/ontology lineage** — make `model_id`, embedding `dimension`,
   enricher model + version, and ontology version first-class on each chunk
   (some is in `metadata`; promote it). Enables reproduce/audit/invalidate when a
   model or ontology changes (cf. the `dispatchedImage` run-provenance fix).
4. **Source provenance** — add `commit_sha` + author + authored-at per chunk by
   joining `repo_commits`. Pairs with #1 for full `file:line:commit` citations.
5. **Standard export / interchange** — target the RAG-domain standards, not SBOM:
   **MLCommons Croissant** (ML dataset metadata — the "data card" for the KB),
   **W3C PROV / OpenLineage** (pipeline + chunk lineage), optionally **C2PA**
   (content provenance). Mirror how the tech-extractor exports CycloneDX in *its*
   domain.

### Value
Trustworthy/citable RAG (`file:line:commit` on every retrieved chunk = recruiter-grade,
anti-hallucination), consistency (canonical skills), reproducibility (lineage),
interoperability (standard data/lineage manifest).

### Sources

- [MLCommons Croissant](https://github.com/mlcommons/croissant) — ML dataset metadata
- [OpenLineage](https://openlineage.io/) — pipeline/data lineage
- [W3C PROV](https://www.w3.org/TR/prov-overview/) — provenance ontology

---

## Backlog (add new items below)

- Share one tarball fetch between ingestion + tech-extractor (remove the
  duplicated repo download; the only genuine inefficiency in the two-Job split).
- **Embedding nearest-canonical skill resolution (external-taxonomy alignment).**
  Live proof (tucaken-infra re-sync 2026-06-18): **5,004 distinct** free-text skill
  phrases in ONE repo — exact-alias resolution can't collapse descriptive LLM
  output. Chosen design: nearest-canonical over Titan embeddings (our infra, no
  external runtime dep). Sub-slices:
  - **A (done)** — migration 094 (`skill_ontology.embedding vector(1024)` + hnsw
    cosine) + `SkillEmbeddingResolver.resolveByVector` (threshold, else null) +
    tests. PR pending.
  - **B** — taxonomy import + Titan backfill: load a real vocabulary into
    `skill_ontology` (ESCO is a free downloadable RDF/SKOS dump ~13k, no API key —
    simplest for this approach; Lightcast Open Skills ~34k is API-only/free-reg),
    then embed each canonical once. A Job.
  - **C** — wire into `BedrockChunkEnricher`: embed each emitted skill phrase,
    resolve via `SkillEmbeddingResolver`, else keep raw. Replaces the exact-alias
    map. **Gated on D.**
  - **D** — resolution eval + threshold tuning (per CLAUDE.md rule 5): sample
    phrases -> expected canonical, pick the cosine floor, measure false-collapse
    rate. No production wiring (C) ships without it.
- **Align role ontology to an external taxonomy** (the original, role side).
  Today `skill_ontology` (092/093) + `role_ontology` (072/073) carry a curated
  in-house vocabulary. 2026 best practice is to adopt a standard taxonomy as the
  canonical spine and keep our `*_aliases` for local synonyms — same schema, real
  taxonomy underneath. Candidates: **Lightcast Open Skills** (~33k skills, open,
  free, biweekly refresh, has a Skills Extractor + API — the obvious fit) or
  **ESCO** (~13k skills / 3k occupations, RDF/OWL/SKOS + free API, multilingual);
  **O*NET / SOC** and **Lightcast Open Occupations** (~1,900) for roles. Scope: an
  importer (taxonomy -> `skill_ontology`/`role_ontology` rows with category
  mapping), our aliases layered on top, and a refresh Job. The alias->canonical
  model we already have is exactly SKOS `prefLabel`/`altLabel`, so the schema is
  ready. Licensing: Lightcast Open Skills + ESCO are free/open. Effort: a proper
  sub-project (importer + mapping + refresh), not a single PR.
  Sources: Lightcast Open Skills <https://lightcast.io/open-skills>; ESCO model
  <https://data.europa.eu/esco/model>.
- _(add follow-up items here)_
