<!-- @format -->

# evidence/

The **repo evidence signals** the rest of the platform trusts: deterministic
facts derived from a repo's file tree at ingestion time, and the
authorship/tech metadata stamp applied to every retrieval chunk. Everything
here runs before or independently of any LLM; these are the ground truths
the generation pipelines cite.

Two halves:

1. **Signal derivation** (`repo-signals.ts`, `evidence-topology.ts`) - pure
   functions the ingestion orchestrator calls with the full file tree, whose
   output lands in `repo_sync_state`.
2. **The evidence stamp** (`evidence-metadata-stamp.ts`,
   `apply-evidence-stamp.ts`) - a JSONB patch merged onto
   `document_embeddings.metadata` so filter-then-rank retrieval can gate
   fork/low-trust evidence and pre-filter by tech without joins.

## Signal derivation (ingestion-time)

`RepoIngestionOrchestrator.persistArchetypeSignals` calls both functions on
every ingest and force-reindex, then persists best-effort (a failure never
aborts the run):

| Function | Output | Persisted to |
| --- | --- | --- |
| `deriveRepoSignals(files, opts)` | the canonical **46-key boolean map** (`has_iac`, `has_k8s_manifests`, `has_helm_chart`, `has_argocd_apps`, `has_dockerfile`, `has_ci`, `has_notebooks`, `has_migrations` and friends) that the archetype ontology gates on | `repo_sync_state.archetype_signals` |
| `deriveEvidenceTopology(files, packageJsons)` | script presence (`has_test_script`, `has_lint_script`, `has_build_script`, `has_typecheck_script`), DB migrations (`has_migrations` + `migration_tools`, detected generically across ~20 ecosystems from Prisma to Flyway), `is_monorepo`, language breakdown | `repo_sync_state.evidence_topology` |

Both work from file paths plus parsed `package.json` manifests only; two
keys (`has_app_store_link`, `has_live_url_in_readme`) always report false
because they would need README content.

Consumers: `../grounding` (component kinds), `../case-study` (depth markers,
archetype classification), and the ingestion file classifier.

## The evidence stamp (retrieval-time trust)

`buildEvidenceStamp` is the pure builder: per-repo `RepoSignals` in, the
metadata patch out.

| Stamp key | Meaning |
| --- | --- |
| `is_fork` | HARD retrieval gate; fork code is never the user's authorship |
| `repo_classification` | copy of `repository_profiles.classification` (values listed in the root README) |
| `repo_confidence` | soft rank signal (`quality_score`, 0..1) |
| `authored` | user committed to the repo, or owns it (and it is not a fork) |
| `role_inferred` | negation of `authored`; downstream copy must frame contributions cautiously, never "built" |
| `owner_is_user` | repo owner equals the user's connected GitHub login |
| `repo_tech_stack` | code-derived canonical tech list |
| `repo_domain` | domain when known |

`stampUserEvidenceMetadata` is the applier: at the end of each successful
ingestion run it reads `oauth_connections` (GitHub login),
`repository_profiles`, `repo_commits` (authorship), and
`technology_evidence` + `technology_ontology` (code layers `syft`,
`treesitter`, `iac`, `dockerfile`), then merges the stamp onto every chunk
of every repo (`metadata || patch`, never replacing) and adds a per-file
`file_tech_stack` key so retrieval can gate a monitoring YAML out of a
Python JD. Idempotent; re-runs each sync; back-fills the whole corpus.

## Files

| File | Role |
| --- | --- |
| `repo-signals.ts` | `deriveRepoSignals` + `REPO_SIGNAL_KEYS`: the 46-key archetype signal vocabulary, from file paths only. Pure. |
| `evidence-topology.ts` | `deriveEvidenceTopology`: scripts, migrations, monorepo shape, language breakdown. Pure. |
| `evidence-metadata-stamp.ts` | `buildEvidenceStamp`: the pure stamp builder (`RepoSignals` → `EvidenceStamp`). |
| `apply-evidence-stamp.ts` | `stampUserEvidenceMetadata`: the SQL applier that loads the signals and merges the stamp onto `document_embeddings`. |
| `__tests__/` | Unit tests for the derivations and the stamp builder. |

The builder/applier split is deliberate: `evidence-metadata-stamp.ts` stays
pure and unit-testable; `apply-evidence-stamp.ts` owns the five-table SQL.
