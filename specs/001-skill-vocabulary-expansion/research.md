# Phase 0 Research: Skill Vocabulary Expansion

Resolves the open decisions in the plan's Technical Context.

## D1 — O*NET acquisition: downloadable bundle, not the live API

- **Decision**: Acquire O*NET from its **downloadable database bundle** (O*NET Resource Center, text/Excel + machine-readable CTDL JSON-LD), cached once per import, parsed offline. Not the per-call web API.
- **Rationale**: No API key or rate-limit handling; the data is versioned + stable between releases; a one-off Job parsing a cached file is simpler and reproducible. CC-BY 4.0 permits commercial reuse with attribution.
- **Alternatives**: Live O*NET Web Services API — rejected: key management + rate limits + per-call latency for no benefit on a batch import. Lightcast — rejected (Constitution/spec: commercial use needs a paid contract).
- **Constraint applied**: the bundle download uses the new capped-fetch helper (timeout + max-byte cap) per Constitution V.

## D2 — Source scope: O*NET capability + curated tail ONLY (registries stay in technology_ontology)

- **Decision**: This feature imports **O*NET** (the Skills/Abilities capability backbone + the Technology-Skills software layer, mapped to the 15 skill categories) plus the **project curated tail**. It does **NOT** import package registries (npm/PyPI/…) into `skill_ontology`.
- **Rationale (sharpens the spec's FR-002)**: the package-registry **tool** vocabulary is already canonicalised in `technology_ontology` by the existing technology importer. `skill_ontology` is the **capability** layer ("kubernetes networking", "rest api design"), a different axis. Re-importing tools into `skill_ontology` would duplicate the tech axis and conflate tools with capabilities. So "the technology layer" the spec references is **reused from `technology_ontology`**, not re-imported here — the new sources are O*NET + curated.
- **Honest tradeoff**: O*NET's capability layer is coarse on bleeding-edge engineering ("Programming", not "pgvector hybrid retrieval"). The curated tail carries the fast-moving engineering capabilities O*NET lacks — this is the deliberately-owned layer (the moat), exactly as the spec's Assumptions state.
- **Alternatives**: ESCO ICT skills — deferred as an optional EU facet (coarser on dev tooling, separate licence diligence); deriving skill canonicals from `technology_ontology` tool names — rejected for v1 (conflates tool↔capability; revisit if coverage demands it).

## D3 — Categorisation into the 15 skill categories

- **Decision**: Reuse the existing `Categorizer` (L1–3 deterministic patterns/overrides + L4 Claude Haiku **batch**), with a **new skill-specific pattern/override set** mapping O*NET groupings → the 15 `skill_ontology` categories (`language, backend, frontend, infrastructure, devops, data, ml, observability, security, testing, api, database, architecture, cloud, other`).
- **Rationale**: O*NET ships taxonomy codes/families that map deterministically for most entries (L1–3); only the residual grey band needs the LLM, which the proven batch path already handles cheaply.
- **Eval (Constitution VI)**: categorisation correctness is bounded by the **resolution eval** (SC-002) — the vocabulary is not relied upon until recall/precision over alias positives holds vs the 75-seed baseline; mis-categorised entries surface as resolution regressions.

## D4 — De-duplication threshold

- **Decision**: Two-track. (a) The **7 known seed duplicates** (cross-functional partnership/collaboration/leadership 0.817/0.678/0.663, data-driven decisions/data-driven 0.738, user/customer empathy 0.692, user empathy/empathy 0.589) are merged **explicitly** in migration 095 (deterministic, reviewed). (b) For **new imports**, auto-merge canonicals at cosine **≥ 0.85** (well above the 0.62 resolve threshold, so only true near-duplicates merge); route the **0.70–0.85 grey band** to the existing `ontology_review_queue` rather than auto-merging.
- **Rationale**: grounded in the live separation data — median nearest-neighbour 0.322, p90 0.580, so 0.85 is far into the "same concept" tail and safe; the grey band is where soft-skill paraphrases live and deserves human review, reusing the importer's existing review queue.
- **Alternatives**: a single low auto-merge threshold — rejected (would merge genuinely distinct adjacent skills); no dedup — rejected (FR-006 + the known false-merge risk).

## D5 — Provenance + licence (FR-009, SC-003)

- **Decision**: migration 095 adds `source_licence TEXT`, `source_url TEXT`, and reuses the existing `source` column for the source name on `skill_ontology`; the importer stamps every row it writes. An audit query (`source_licence NOT IN (<approved>)`) must return zero rows (SC-003).
- **Rationale**: licence safety is a first-class spec requirement; recording it per-row makes the legal basis auditable without external lookup, and is the cheapest way to *enforce* "commercial-safe only" as a check rather than a hope.

## D6 — Embedding the new vocabulary

- **Decision**: After upsert, the Job calls the existing **`backfillSkillEmbeddings`** (roadmap #2) — idempotent, embeds only `embedding IS NULL` rows. No new embedding code.
- **Rationale**: the resolver is already a working socket; the only thing standing between a new canonical and resolution is a vector, which the backfill fills. This is the whole "feed the socket, don't rebuild it" thesis.

## D7 — O*NET DROPPED after inspecting the real bundle (supersedes D1–D2 on O*NET)

- **Decision**: Do **not** import O*NET into `skill_ontology`. The capability primary becomes the **project curated vocabulary**; tool-centric skill phrases are covered by **deriving skill canonicals from the already-imported `technology_ontology`**.
- **Evidence (O*NET database 29.1, downloaded + inspected 2026-06-19)** — verified bytes, not assumption:
  - `Skills.txt` — **35 distinct** Element Names, all generic work skills ("Active Learning", "Critical Thinking", "Coordination"). Zero software-engineering granularity.
  - `Technology Skills.txt` "Example" — **8,768 distinct tools** ("Adobe Acrobat"…). These are *tools* → `technology_ontology` (already imported from registries), not the capability layer.
  - `Technology Skills.txt` "Commodity Title" — **135 software categories** ("Application server software"…), of which only ~30–40 are software-engineering-adjacent and all are **coarse** (none is "kubernetes networking" / "rest api design").
- **Rationale**: the 17,138 LLM skill surface-forms cluster at fine engineering granularity that O*NET simply does not contain — importing it would add coarse noise, not coverage, and risk *reducing* resolution precision. The "understand the data before ingesting" preview caught this before a single row was written.
- **Revised source set**: (1) **curated** engineering vocabulary (primary, the moat — expand it); (2) **technology_ontology-derived** skill canonicals (the registry tools already canonicalised, surfaced into the skill lane so tool-centric phrases collapse). Both are commercially safe (own-curated; registry-derived). O*NET attribution is no longer needed.

### D7a — derive ONLY the curated technology_ontology rows (verified, 2026-06-19)

Inspecting the real `technology_ontology` (2,483 active) showed it is **mostly registry noise**: transitive crate internals (`typenum`, `ruint-macro`, `ark-ff-asm`, `ctr`, `string_cache`) miscategorised as `language`, and mislabels (`apache-airflow` → observability). Deriving all 2,483 would import garbage as skills — worse than O*NET. There is **no popularity signal** (all NULL), but `curation_level` cleanly separates: **106 curated** (hand-vetted: `argocd`, `aws_cdk`, `aws_eks`, `aws_lambda`, `ansible`, `alertmanager`…) vs 2,377 auto-imported noise. **Decision**: the derivation provider filters to `curation_level = 'curated'` — 106 high-signal tech canonicals. Underscore canonicals (`aws_cdk`) are normalised to the spaced form (`aws cdk`) with the raw form kept as an alias, to match LLM phrasing. The 2,377 auto-imported rows are excluded until/unless a quality signal (e.g. the future JD-driven agent promoting JD-mentioned tech to curated) makes them trustworthy.
- **Spec impact**: FR-001 (O*NET capability import) is withdrawn; FR-002's "technology layer" is now satisfied by deriving from `technology_ontology` rather than re-importing registries. SC-003 (licence audit) is unchanged and easier — only `curated` + the registry-derived provenance remain.

## Resolved unknowns

All Technical-Context items are resolved; **no `NEEDS CLARIFICATION` remain**. The material change vs the original spec: **O*NET is dropped (D7, on verified data)** and the vocabulary is **curated + technology_ontology-derived**. SC-001 coverage is now driven by the curated engineering tail (exact granularity) plus the registry tool canonicals — where the 17,138 surface-forms actually cluster.
