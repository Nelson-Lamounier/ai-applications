# Syft direct-dependency filter — design

**Date:** 2026-06-24
**Status:** approved (design)
**Area:** `applications/tech-extractor` (the deterministic technology-evidence pipeline)

## Problem

The `syft` source layer runs `syft scan dir:<repo>`, which parses lockfiles
(`yarn.lock`, `package-lock.json`, `Cargo.lock`, …) and emits a **flat list of
the fully-resolved dependency tree — direct AND transitive**, with **no
direct/transitive flag**. So transitive utilities (`lru-cache`, `semver`,
`chalk`, `glob`, `debug`, `supports-color`, `json5`, `commander`, `yargs`, …)
that happen to exist in `technology_ontology` survive the downstream
`JOIN technology_ontology` and dilute the repo's headline stack.

Measured on `Nelson-Lamounier/frontend-portfolio`: 2,869 raw `technology_evidence`
rows → 59 surfaced (after the ontology join + `CODE_LAYERS` filter + dedupe), of
which roughly **half are transitive-utility noise**. The `syft` layer (yarn.lock,
991 rows) is the source of that noise. `node_modules` is **not** involved (0 rows).

## Goal

Keep only **directly-declared** dependencies in the `syft` layer — dropping
transitive ones — so the surfaced technology stack reflects what the repo
actually chose to use. Generalise across **every ecosystem that has a
declared-deps manifest**, with **fail-open per ecosystem** so anything without a
parser or manifest is never regressed.

## Key facts (verified)

- `applications/tech-extractor/src/extractors/SyftExtractor.ts` shells out to
  `syft scan dir:<rootDir> -o syft-json` and `parseSyftJson()` maps each artifact
  to `{ raw_name, ecosystem: a.type, source_layer: 'syft', file_path, version }`.
  No direct/transitive metadata is available from syft.
- The orchestrator (`TechExtractOrchestrator`) collects extractor rows, resolves
  `technology_id` via `OntologyResolver`, and `insertMany` persists them. Filtering
  before persist needs **no schema change**.
- Downstream consumers read `technology_evidence` with
  `JOIN technology_ontology o ON o.id = te.technology_id AND te.source_layer = ANY(CODE_LAYERS)`
  where `CODE_LAYERS = ['syft','treesitter','iac','dockerfile']`
  (`applications/shared/src/projects/case-study-loader.ts:105`). **No consumer
  relies on transitive syft rows**, so dropping them is safe.
- The repo tree (extracted tarball) is on disk at extraction time, so all
  manifest files (root + workspaces) are readable.

## Design decisions (locked)

1. **Scope:** all ecosystems that have a declared-deps manifest **and** a parser
   in this change. First cut: **npm, go, python, rust, ruby, php**. Java/Maven
   (`pom.xml`/Gradle) is **deferred** (lower value; resolves transitive at build,
   harder to parse reliably). Any ecosystem without a parser → fail-open (keep all).
2. **Direct set per ecosystem:** every explicitly-declared dependency map.
   - **npm** (`package.json`): `dependencies + devDependencies + peerDependencies + optionalDependencies` keys, unioned across **all** workspace `package.json` files.
   - **go** (`go.mod`): module paths in `require` blocks **without** a `// indirect` comment.
   - **python** (`pyproject.toml` `[project].dependencies` / `[tool.poetry.dependencies]`; and/or `requirements*.txt` lines): declared distribution names.
   - **rust** (`Cargo.toml`): `[dependencies]`, `[dev-dependencies]`, `[build-dependencies]` keys.
   - **ruby** (`Gemfile`): `gem "name"` declarations.
   - **php** (`composer.json`): `require` + `require-dev` keys (excluding the `php`/`ext-*` platform entries).
3. **Fail-open:** when an ecosystem has no parser, or no manifest is found/parsed
   for it, **keep all** of that ecosystem's syft rows. The filter only narrows
   where it has a real direct-set.

## Architecture

### 1. Per-ecosystem manifest parsers — `manifest-parsers/`

One small, pure function per ecosystem. Signature:

```text
parseNpm(content: string): string[]      // direct dependency names
parseGoMod(content: string): string[]
parsePyproject(content: string): string[]
parseRequirements(content: string): string[]
parseCargo(content: string): string[]
parseGemfile(content: string): string[]
parseComposer(content: string): string[]
```

Each parser also owns its **name normalisation** (lowercase, hyphen/underscore
canonicalisation for python, full module path for go) so the keep-set matches
syft's `raw_name` for that ecosystem.

### 2. Direct-deps collector — `collectDirectDeps(files, readFile): Map<ecosystem, Set<string>>`

- Selects manifest files from the repo file list by basename/glob, **excluding**
  `node_modules/`, `vendor/`, `dist/`, `.git/`.
- For each manifest, runs the matching parser, normalises names, and unions into
  `Map<ecosystem, Set<normalisedName>>` (workspace manifests merge into one npm set).
- An ecosystem key is present **only** if at least one manifest for it parsed
  successfully (drives fail-open).

The ecosystem keys are the syft `a.type` values (`npm`, `go-module`, `python`,
`rust-crate`, `gem`, `php-composer`) — a small mapping table aligns parser output
to syft's type strings.

### 3. Filter — applied to syft rows only

`filterSyftDirect(rows, directByEcosystem)`:

```text
keep row r iff:
  normaliseEcosystem(r.ecosystem) has NO entry in directByEcosystem   // fail-open
  OR  normaliseName(r.ecosystem, r.raw_name) ∈ directByEcosystem[eco]
```

Wired in `SyftExtractor` (it gets the collected `directByEcosystem` via
constructor/opts) or in `run-tech-extract.ts` immediately after the syft extract,
before the orchestrator persists. Non-syft layers are untouched.

### 4. Wiring in `run-tech-extract.ts`

Collect direct deps once from the extracted tree (the file list is already built
for the other extractors), pass the map to the syft filter. No new I/O beyond
reading the manifest files already on disk.

## Data flow

```text
extracted repo tree
   │  collectDirectDeps(files, readFile)  ──►  Map<ecosystem, Set<directName>>
   │
syft scan ──► parseSyftJson ──► raw syft rows (direct + transitive)
   │  filterSyftDirect(rows, directByEcosystem)   // npm/go/python/rust/ruby/php
   ▼
direct-only syft rows  ──►  orchestrator (resolve technology_id) ──► insertMany
```

## Error handling / fail-open

- A manifest that fails to parse contributes nothing → if it was the only
  manifest for its ecosystem, that ecosystem stays absent from the map → all its
  syft rows are kept (fail-open).
- No manifests at all → empty map → every syft row kept (current behaviour).
- The collector never throws into extraction; a parser error is caught per file
  and logged.

## Testing

- **Unit (per parser):** manifest text → expected direct names, including the
  edge cases (npm 4 maps + workspaces; go `// indirect`; python case/underscore;
  php platform-entry exclusion). Fixtures with transitive entries absent from the
  manifest.
- **Unit (filter):** transitive row dropped; direct row kept; row of an ecosystem
  with no manifest kept (fail-open); name-normalisation match (`PyYAML`↔`pyyaml`).
- **Unit (collector):** monorepo union across workspace `package.json`; excludes
  `node_modules`.
- **Existing `parseSyftJson`/`SyftExtractor` tests stay green** (the parser output
  is unchanged; the filter is a separate step).

## Eval (per the repo's per-phase-evals rule)

A report-only eval (mirrors the existing tech-extractor eval style): re-run the
extractor against `frontend-portfolio` (npm) and, if available, one repo per other
ecosystem; compare the **surfaced** technology set (the `CODE_LAYERS` + ontology
join) before vs after. Success = the transitive utilities
(`lru-cache`/`semver`/`chalk`/`glob`/`debug`/…) disappear while the real stack
(`react`/`tailwindcss`/`aws_bedrock`/`zod`/`d3`/`esbuild`/…) is retained. Report
before/after counts; no DB writes in the eval.

## Deploy & apply

- No migration. The tech-extractor image rebuilds + redeploys; the filter applies
  on the next extraction of a repo (a re-sync / re-extract).
- Existing rows are not retro-cleaned by this change; a re-extract overwrites a
  repo's evidence (the `ON CONFLICT` upsert refreshes provenance, and dropped
  transitive rows simply stop being re-inserted — they remain until a cleanup,
  but they are already filtered out downstream by the ontology join, so they are
  harmless). An optional one-off cleanup of stale transitive rows is out of scope.

## Out of scope

- Java/Maven (`pom.xml`) / Gradle parsers — deferred.
- Retro-cleanup of already-stored transitive rows.
- Changing `github-sbom` (already excluded from `CODE_LAYERS`) or other layers.
- Any change to `technology_ontology` or downstream consumers.
