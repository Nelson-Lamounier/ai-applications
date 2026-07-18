<!-- @format -->

# @bedrock/shared

The shared workspace library every application in this monorepo builds on.
It is consumed exclusively through the root barrel (`src/index.ts`, published
as `@bedrock/shared` with no subpath exports): the data layer, security and
sanitisation, caching, observability, the projects domain, and the export
standards all live here, so each app package stays a thin composition of
entrypoints over these modules.

Consumers today: `ingestion` (the heaviest), `job-strategist`,
`article-pipeline`, `chatbot-public`, `chatbot-authenticated`,
`resume-import-processor`, `ontology-importer`, `platform-job-watcher`.

## Directory map

| Directory | Role |
| --- | --- |
| `rds/` | The Aurora Postgres + pgvector data layer: types, interfaces, ~25 implementations, and the pure quality/diagnostic/profile/ontology/enrichment computations. The hub of the package. |
| `security/` | Text-layer defence: input injection guarding, output redaction, PII scrubbing with pluggable detectors. |
| `crypto/` | AES-256-GCM envelope encryption backed by AWS KMS, for secrets at rest. |
| `sbom/` | CycloneDX 1.6 software-bill-of-materials export of a repo's verified technology evidence. |
| `rag/` | MLCommons Croissant data-card export describing a repo's chunk + embedding corpus. |
| `prose-quality/` | Flag-only prose critic scoring LLM output against the stop-slop rule set. |
| `retrieval/` | Retrieval-time components (pgvector retriever + Bedrock reranker), storage-agnostic. |
| `projects/` | The Projects domain: clustering, case studies, system tours, change impact, evidence signals (has its own [README](src/projects/README.md)). |
| `stage-prep/` | Interview stage-prep ontology, evidence lanes (DSA/AI), concern detection, bar-raiser types. |
| `chatbot/` | Shared chatbot logic: context builder, query expander, system prompt, zero-result recording. |
| `cache/` | Redis-backed exact/read caches (shared instance, key-prefix separated) and the pgvector semantic cache. |
| `observability/` | Bootstrap + metrics helpers for K8s jobs, Lambda, Bedrock and GenAI cost/EMF emission. |
| `grounding/` | Answer-grounding verifier: checks generated claims against retrieved evidence. |
| `github/` | Pure GitHub App utilities: webhook signature verification and App JWT auth. |
| `config/` | Feature-flag wrapper over the `app_config` key/value JSONB table. |
| `bedrock/` | Bedrock batch-enrichment helper (`BedrockBatchEnrich`). |
| Root modules | `agent-runner.ts` (`runAgent`: one Converse call with a forced tool + cost booking), `base-agent.ts`, `repo-entities.ts` (repo/commit/PR contract types), `github-errors.ts`, `strategist-types.ts` (the strategist payload contracts), `logger.ts`, `metrics.ts`, `emf.ts`, `types.ts`. |

The rest of this README details the six subsystems people ask about most:
`rds`, `security`, `crypto`, `sbom`, `rag`, `prose-quality` — plus how
`rag/` differs from `retrieval/`.

---

## rds/ - the data layer (the hub)

The largest and most heavily consumed module: everything that reads or
writes the platform's Aurora Postgres (pgvector) database goes through it.
Three structural layers plus five pure-computation subfolders:

| Subfolder | Contents |
| --- | --- |
| `types/` + root `types.ts` | Domain value types: `RawChunk`, `DocumentChunk`, `SimilarityResult`, `RepoSyncState`, the tech-graph source-layer confidence weighting (`syft > github-sbom > treesitter > iac > ...`), role-ontology and ontology-import types. |
| `interfaces/` | The ports: `IVectorStore`, `IEmbeddingProvider`, `IChunkEnricher`, `ISyncStateRepository`, plus read-repository contracts (career history, diagnostic inputs, OAuth connections, profile rollup). |
| `implementations/` | ~25 concrete AWS-backed classes. Flagships: `RdsVectorStore` (pgvector store, one SQL operation per method, hybrid vector+BM25 retrieval with the filter-then-rank authorship gates), `TitanEmbeddingProvider` (Titan Embed Text v2, 1024-dim), `TechnologyEvidenceRepository` (evidence rows + the CycloneDX bridge), `RdsOAuthConnectionsRepository` (the crypto bridge), the Ontology repository family. |
| `quality/` | Pure derivation of the 0-1 KB-quality score + breakdown persisted to `repo_sync_state` for the UI, and the retrieval-probe maths. |
| `diagnostic/` | Pure per-user diagnostic scoring (profile depth, RAG depth, direction confidence, reconciliation alignment, resume coverage). |
| `profile/` | Pure cross-repo profile rollup over `repository_profiles` (deterministic, zero I/O). |
| `ontology/` | Skill/role canonicalisation: the strict in-memory `OntologyResolver` (no fuzzy matching), embedding-assisted resolvers, dedupe/canonicalisation helpers, and the ontology gap recorder that feeds vocabulary growth. |
| `enrichment/` | Pure chunk-enrichment helpers: evidence-predicate skill assignment, chunk grouping/packing, tier-1 deterministic skill rules. |

Dominant consumer is the `ingestion` app (pipeline, orchestrator, profile
synthesis, persistence); `job-strategist`, `article-pipeline` and both
chatbots consume the store/retrieval surfaces.

## security/ - text-layer defence

The shared sanitisation API for every LLM-facing app. `InputSanitiser`
guards inbound text against prompt injection and jailbreak patterns
(throwing `InputSanitisationError`); `OutputSanitiser` applies redaction
rules to model output; `PiiScrubber` orchestrates pluggable `IPiiDetector`
implementations (`RegexPiiDetector`, AWS Comprehend-backed
`ComprehendPiiDetector`) under a configurable `RedactionPolicy`.

Widely consumed directly: `job-strategist` (pipeline, coach, agents),
`resume-import-processor` (imports handle user documents), `article-pipeline`
and `ingestion`. The copies that once lived inside `job-strategist` are
deprecated shims re-exporting from here - this module is the single source
of truth. Note the boundary: `security/` is text hygiene; encryption at
rest is `crypto/`'s job, and the two are deliberately independent.

## crypto/ - at-rest encryption

One focused capability: AES-256-GCM **envelope encryption** backed by AWS
KMS (`createKmsEnvelope`). Every encrypt requests a fresh data key from
KMS, uses it once, zeroes the plaintext key, and stores the wrapped DEK
alongside the ciphertext; an optional context object becomes KMS
EncryptionContext (authenticated additional data), binding a ciphertext to
its owning row. Tampering surfaces as `IntegrityError`.

Its only in-repo consumer is `rds/` - specifically the OAuth connections
repository (GitHub tokens at rest) and its backfill. Applications never
touch it directly.

## sbom/ - the technology export standard

Pure, no I/O. Converts a repo's `technology_evidence` rows into a
standards-compliant **CycloneDX 1.6** software bill of materials:
`purl.ts` builds canonical Package URLs (`pkg:npm/...`; non-package
ecosystems fall back to `generic`), and `cyclonedx.ts` assembles the
component array (`buildCycloneDxBom`, `preferSpecificPurls`).

Sole consumer: `TechnologyEvidenceRepository.toCycloneDxBom()` in `rds/` -
apps reach the BOM through that repository method.

## rag/ - the corpus export standard

The structural twin of `sbom/`, for the knowledge base: `buildCroissant`
emits an **MLCommons Croissant** data card describing a repo's chunk +
embedding corpus in `document_embeddings` (record count, commit SHA,
embedding model and dimension, skills vocabulary). Also pure, also
single-consumer: `RdsVectorStore.toCroissant()`.

**`rag/` is not the retrieval layer.** The sibling `retrieval/` directory
holds the runtime fetch-and-rank components - `PgVectorRetriever` and the
`BedrockReranker` - kept out of `rds/` because they are storage-agnostic.
`rag/` *describes* the corpus; `retrieval/` *queries* it. Retrieval's
consumers are the two chatbots and the article/job-strategist research
agents.

## prose-quality/ - the AI-tell critic

A flag-only prose linter: `BedrockProseLinter` scores LLM prose against the
forked stop-slop rule set (`rules/phrases.ts`, `rules/structures.ts`, pass
threshold in `rules/rubric.ts`) and lists AI-tell issues as structured
`ProseIssue`s. It runs in the same pipeline slot as the grounding verifier
and **never mutates persisted output** - it flags; humans and evals judge.
Ships its own system prompt + tool schema, eval fixtures under `evals/`,
and rule provenance in `PROVENANCE.md`.

Consumers: `job-strategist` (resume and coach prose) and `article-pipeline`
(evidence adjudicator).

---

## How the six fit together

```text
security ──(standalone)──▶ every LLM-facing app          text in/out hygiene
crypto ───▶ rds (OAuth tokens at rest)                    KMS envelope
sbom ────▶ rds (TechnologyEvidenceRepository → CycloneDX) export standard
rag ─────▶ rds (RdsVectorStore → Croissant data card)     export standard
rds ─────▶ ingestion, job-strategist, chatbots, articles  the hub
prose-quality ──▶ job-strategist, article-pipeline        flag-only critic
```

Two conventions worth knowing when adding code here:

- **`rds/` is the hub.** It consumes three of the other five modules and is
  itself the most-consumed. Anything storage-shaped belongs behind its
  interfaces; pure computations get their own subfolder beside `quality/`
  and `profile/` rather than living inside an implementation class.
- **`sbom/` and `rag/` are standards adapters** - tiny, pure,
  single-purpose modules that turn internal evidence into industry formats
  (CycloneDX, Croissant), surfaced through an `rds` repository method. Any
  future export surface should repeat this pattern rather than growing
  bespoke serialisation inside a repository.

Everything is re-exported through `src/index.ts`; new modules are born in
the matching directory and added to the barrel - no app may deep-import a
file path from this package.
