# Knowledge Base Source Repository Guide

**Audience:** Repo owners feeding the Tucaken ingestion adapter (and the maintainer
deciding what shape `wiki/` and project READMEs should take).

**Scope:** What the GitHub adapter currently extracts, how chunks are built, what
metadata survives into pgvector, and how the source repo must be structured so
that retrieval surfaces correct, rich, and cross-cutting answers.

**Reference KB:** [`Nelson-Lamounier/portfolio-research-brain`](https://github.com/Nelson-Lamounier/portfolio-research-brain)
— the manually-curated wiki under `wiki/` is the gold-standard target. Everything
this document recommends is the *automatable subset* of what that repo does by
hand. **Start by ingesting `wiki/`.** If the adapter cannot produce useful chunks
from a repo that is *already structured for an LLM*, no amount of content effort
on customer repos will help.

---

## 1. What the Adapter Actually Sees

Sources reviewed:
- `applications/shared/src/ingestion/implementations/GitHubAdapter.ts`
- `applications/shared/src/ingestion/implementations/FileFilter.ts`
- `applications/shared/src/ingestion/implementations/MarkdownChunker.ts`
- `applications/shared/src/ingestion/implementations/DefaultChunker.ts`
- `applications/shared/src/ingestion/orchestrator/RepoIngestionOrchestrator.ts`
- `applications/platform-rds-bootstrap/src/index.ts` (DDL/schema)

### 1.1 Pipeline at a glance

```
GitHub Tree API (recursive=1)
  → FileFilter (include/exclude globs + 500 KB size cap)
  → fetchFile (Blob API, base64 decode)
  → ChunkerRegistry routes by extension
       .md / .mdx  → MarkdownChunker (heading-aware)
       everything  → DefaultChunker  (80-line sliding window, 10-line overlap)
  → IngestionPipeline (hash-skip, embed via Titan v2 1024-dim, upsert pgvector)
```

### 1.2 Filter defaults — what gets in, what doesn't

**Included extensions (root pattern `**/*.{ext}`):** `md`, `mdx`, `ts`, `tsx`,
`js`, `jsx`, `py`, `yaml`, `yml`, `json`.

**Hard-excluded paths:** `node_modules/**`, `.yarn/**`, `vendor/**`, `dist/**`,
`build/**`, `out/**`, `.next/**`, `cdk.out/**`, `coverage/**`, all `*.d.ts`,
`*.js.map`, `*.test.{ts,tsx}`, `*.spec.{ts,tsx}`, `__tests__/**`,
`__mocks__/**`, lockfiles, `*.min.{js,css}`.

**Size cap:** any file > 500 KB is dropped before any byte is fetched (the size
comes from the Tree API, so the network cost is zero).

**Implication:** if your repo's documentation lives in `docs/dist/`,
`generated-docs/`, or in test fixtures, **it will not be ingested**. Don't put
narrative content under build-output directories.

### 1.3 What metadata reaches the database

`document_embeddings` columns populated per chunk
(`applications/platform-rds-bootstrap/src/index.ts:76`):

| Column | Source | Used for |
|---|---|---|
| `user_id` | Caller | Tenant isolation (multi-tenant retrieval) |
| `repo_full_name` | Caller (`owner/repo`) | Per-repo filtering, dedupe key |
| `file_path` | GitHub Tree path | Display, dedupe key, **directory tags** |
| `heading` | First `^#{1,4}` line above the chunk (markdown only) | Display + retrieval context |
| `content` | The chunk text — heading line is **prepended** to the body | Embedding input + BM25 (`content_tsv`) |
| `file_type` | `md`, `mdx`, or extension (`ts`, `py`, …) | Filter / facet |
| `tags` | Directory segments of `file_path`, minus the filename, minus `.`, minus `_`-prefixed | Faceted filtering |
| `chunk_index`, `total_chunks` | Position in file | Reassembly + dedupe |
| `content_hash` | SHA of `content` | Skip-on-no-change |
| `embedding` | Titan Embed v2 (1024-dim) | Vector similarity (HNSW, cosine) |
| `content_tsv` | Generated column (`to_tsvector('english', content)`) | BM25 hybrid search (GIN) |

**Crucial detail:** `tags` is derived **purely from the directory path**. There
is no parsing of YAML frontmatter, no inheritance from a parent index, no
filename-keyword extraction. **Your directory tree IS your taxonomy.** Plan it
before you write a single doc.

### 1.4 What the MarkdownChunker actually does

1. Strips YAML frontmatter (`---\n…\n---`) before chunking. **Frontmatter is
   invisible to retrieval.** Anything inside `---` will *not* be searchable —
   use it for human/tooling metadata only (title, type, tags, sources, dates).
2. Splits on `^#{1,4}` heading lines (H1–H4). H5/H6 are ignored as boundaries.
3. Each chunk = `heading line + body` (heading prepended so the embedding sees
   it).
4. Sections > 2000 chars are split on blank-line paragraph boundaries; each
   continuation chunk gets a `(continued from: <heading>)` prefix and a 200-char
   tail-overlap from the previous chunk.
5. Sections < 30 chars are dropped silently.

**Implication:** every H2/H3 heading is a *retrievable unit*. A heading with no
body, or a 25-char "TBD" body, simply vanishes. Headings should be self-explaining
because the chunk is retrieved standalone, without surrounding context.

### 1.5 What the DefaultChunker does to code

Plain 80-line sliding window with 10-line overlap. **Not language-aware.** A
function spanning lines 70–110 is split across two chunks at line 80, and the
embedding for the second window starts mid-function with no signature visible
beyond the 10-line overlap. This is a known gap (see §6).

---

## 2. Repository Structure — The Two Models

### Model A — Source code repo (the realistic customer case)

A normal application repo: code, configs, manifests, plus whatever docs the team
already maintains. This is what the adapter *will* see in production.

```
your-app/
├── README.md                 # ← single most important file
├── docs/
│   ├── architecture.md       # one concern per file, H2/H3-driven
│   ├── runbook.md
│   ├── operations.md
│   ├── concepts/
│   │   └── <concept>.md      # explains a concept used by the codebase
│   ├── decisions/
│   │   └── 0001-<title>.md   # ADRs — naturally chunk-friendly
│   └── troubleshooting/
│       └── <symptom>.md      # symptom → root cause → fix
├── src/
│   ├── <module>/
│   │   ├── README.md         # ← per-module narrative if non-trivial
│   │   └── <code>
└── infra/
    └── README.md             # what this folder owns, deploy contract
```

**Why this works for the adapter:**
- `docs/concepts/`, `docs/decisions/`, `docs/troubleshooting/` become tag arrays
  `['docs','concepts']`, `['docs','decisions']`, etc. — facets for free.
- One concern per file → no monster docs that fragment poorly.
- Per-module READMEs anchor narrative next to the code so retrieval can answer
  *"how does the auth module work?"* without dragging in unrelated context.

### Model B — Curated knowledge wiki (what `portfolio-research-brain/wiki/` is)

```
wiki/
├── projects/<name>.md           # one page per app/service
├── concepts/<concept>.md        # design / engineering ideas
├── tools/<tool>.md              # technologies in use
├── patterns/<pattern>.md        # architectural patterns
├── troubleshooting/<symptom>.md # symptom → diagnosis → fix
├── commands/<topic>.md          # executable command references
├── comparisons/<a-vs-b>.md      # side-by-side analyses
└── ai-engineering/<topic>.md    # domain-specific (LLM/RAG/etc.)
```

This is the model Tucaken **builds for the user**. Every `.md` here is a near-
ideal chunk source: short, frontmatter-tagged, single-topic, heading-driven,
cross-linked.

**For the first ingestion test, point the adapter at
`portfolio-research-brain/wiki/` (path filter or repo-level scoping).** It will
produce hundreds of high-quality chunks across a clear taxonomy, exactly the
signal you need to validate retrieval is working.

---

## 3. README Conventions

### 3.1 Repository-root README.md — the load-bearing file

It is the first chunk a retriever finds when someone asks *"what is this repo?"*.
Treat the H2 headings as discrete answers. Use this skeleton (each `##` is a
chunk that can stand alone):

```markdown
# <project-name>

One-paragraph elevator pitch — what this is, who runs it, what it depends on.
Avoid marketing language; state facts.

## What it does
Two or three sentences, concrete. "Generates X from Y by doing Z."

## Architecture
Mermaid diagram + one paragraph naming the components and how data flows.
Avoid ASCII art (chunked as code, hard to read in retrieval results).

## Runtime contract
- Required env vars (name → purpose, no values)
- External services it talks to (with the protocol/auth)
- Inputs / outputs at the system boundary

## Repository layout
A short tree (≤ 30 lines) with a one-line description per top-level folder.
Acts as a map for follow-up retrievals.

## How to run locally
The exact commands. No prose between commands.

## Deploy
Where it deploys, who owns the pipeline, what triggers it. Link to the deploy
workflow path.

## Related repos
| Repo | Role |
| --- | --- |
| `owner/frontend` | UI for this service |
| `owner/infra`    | Provisions the database this service uses |

## Glossary
Domain-specific terms used in the rest of the docs. One bullet each.
```

**Rules of thumb:**
- Each H2 should answer one question end-to-end.
- Keep each H2 under ~1500 chars (well under the 2000-char chunk cap; leaves
  room for the heading prefix + overlap on continuation chunks).
- Put concrete facts (env var names, ARNs templates, port numbers, table
  schemas) in the body — these are gold for retrieval.
- Cross-link to deeper docs with relative paths
  (`See [docs/concepts/auth.md](./docs/concepts/auth.md)`); the adapter does
  not parse Obsidian wikilinks today, but plain markdown links survive as text.

### 3.2 Per-module READMEs

For any module/service inside a monorepo or any non-obvious sub-package:

```markdown
# <module>

Why this module exists and the boundary it owns.

## Public API
Exported symbols with one-line purpose. Don't repeat the type signatures —
TSDoc on the symbols handles that. List names so retrieval can match queries
like "where is `RdsVectorStore` defined?".

## How it talks to the rest of the system
Mermaid sequence or flowchart for the dominant interaction.

## Failure modes
What can go wrong, what the symptom looks like, where to look.
```

These chunks frequently outscore root-README chunks for module-level questions
because their `tags` array includes the module folder.

---

## 4. Markdown Conventions for Ingestion

### 4.1 The contract

| Rule | Why |
|---|---|
| One concept per file. | Tags come from the folder; mixing concepts pollutes the facet. |
| H2/H3 split a page into retrievable units. | The chunker boundaries are exactly H1–H4. |
| Headings must be self-describing (`## Authentication flow`, not `## Step 2`). | Headings are prepended to chunks; vague headings hurt embeddings. |
| Each section ≥ 30 chars and ≤ 2000 chars of meaningful prose. | Below 30 → silently dropped. Above 2000 → split mid-section with overlap. |
| YAML frontmatter holds metadata only — never load-bearing text. | Stripped before chunking. Invisible to retrieval. |
| Mermaid for diagrams, never ASCII. | ASCII art is preserved as text but reads as noise to the embedder. |
| Plain markdown links over wikilinks `[[ ]]`. | Adapter does not resolve wikilinks; their pipe-syntax leaks into the chunk. |
| Code fences identify the language (`` ```ts ``). | Lets future improvements route language-specific code chunks to a smarter chunker. |
| One terminology per repo. Reuse it. | Keyword overlap across pages drives recall. |

### 4.2 What to write (and what not to)

**Write:** explanations of *why* something is the way it is, *what* the
component does in concrete terms, *which* dependencies it has, *how* the
contract is shaped (env vars, schemas, protocols), the *failure modes* and
*operational notes*. These are the questions humans ask and chatbots get asked.

**Don't write (in narrative `.md`):** auto-generated API references regenerated
on every build (they bloat the index and hash-thrash the pipeline), exhaustive
type dumps (TSDoc on the source is better), changelog-style updates that
become stale (put those in releases, PRs, or a tightly-scoped `CHANGELOG.md`).

### 4.3 Service vs. implementation organization

**Recommendation: organize by *concept*, not by service.** A `docs/concepts/`
folder keeps one idea per page regardless of which service implements it; a
`docs/services/<name>/` folder fragments cross-cutting topics into duplicated
sections. Use service folders only for things genuinely scoped to one service
(its runbook, its API).

Concrete pattern (mirrors `portfolio-research-brain/wiki/`):
- `docs/concepts/` — ideas that span services (eventing model, single-table
  design, JWT validation)
- `docs/projects/<service>.md` — one page per service summarizing it
- `docs/patterns/` — reusable patterns (BFF, circuit breaker)
- `docs/troubleshooting/` — symptom-driven, cross-service
- `docs/decisions/` — ADRs

Cross-link liberally. Retrieval ranks pages with a clear path graph higher than
isolated islands because the same terms reappear with proper context.

### 4.4 Tags — the silent index

The chunker writes `tags = directory-segments(file_path).filter(non-empty,
non-dot, non-underscore-prefixed)`. So:

| Path | Tags |
|---|---|
| `docs/concepts/auth.md` | `['docs','concepts']` |
| `services/api/README.md` | `['services','api']` |
| `infra/k8s/charts/api/README.md` | `['infra','k8s','charts','api']` |

**Implications:**
- Don't rely on filenames for taxonomy — only directories survive.
- Don't dump everything in a flat `docs/`; the only tag will be `docs`.
- A `_drafts/` folder is a free way to hide WIP from the index (the underscore
  prefix is filtered out), but you'd still need to add it to `.gitignore` or
  exclude via a future repo-level config to prevent ingestion entirely.
- Two or three folder levels is the sweet spot. Five+ levels mostly produces
  redundant tags.

---

## 5. Code Comments — JSDoc / TSDoc Inclusion

### 5.1 What gets ingested today

Code files are chunked by `DefaultChunker` (line-window). The chunker does not
distinguish comment from code; **a TSDoc block IS embedded as part of the
surrounding window**. Good doc comments materially improve retrieval for
"where is X?" / "how does Y work?" questions because the natural-language
prose lives next to the symbol it describes, in the same window.

### 5.2 What to write on exported symbols

Write **purpose, contract, gotchas, links** on every exported function, class,
and interface. Skip private helpers unless they encode a non-obvious invariant.

```ts
/**
 * Embed and upsert chunks into pgvector, skipping any whose content_hash
 * already matches the stored row.
 *
 * Contract:
 *  - chunks must share a single (userId, repoFullName).
 *  - content_hash is computed from the *normalized* chunk content (heading + body).
 *  - On hash match → row is left untouched; chunk_count.skipped is incremented.
 *
 * Failure modes:
 *  - Bedrock InvokeModel throttling → retried with jitter, surfaced as
 *    UpsertBatchResult.errors (not throws) so partial progress survives.
 *
 * See applications/platform-rds-bootstrap/src/index.ts for the schema.
 */
export async function ingestChunks(...) { ... }
```

**Why this works for retrieval:**
- The TSDoc paragraph naming the contract becomes part of the window that
  contains the function signature. A query like *"does ingestChunks retry on
  throttling?"* hits the right chunk.
- Listing failure modes in the doc gives troubleshooting queries a place to
  land that is co-located with the code that produces the symptom.

### 5.3 What NOT to write

- One-liners that restate the function name (`/** Returns the user. */ getUser()`)
  — pure noise; pollutes the chunk without informational value.
- Multi-paragraph essays repeating the README — duplicates inflate the index
  and shift retrieval rank toward whichever copy is more SEO-friendly inside
  the embedding space.
- Comments referencing PRs or commits ("fixed in #1234") — they rot fast.

### 5.4 File headers (`@format` etc.)

Keep them short. A four-line module-purpose comment at the top of each file is
genuinely useful — it gets bundled into the first chunk and answers
*"what is this file for?"* queries directly.

---

## 6. Gaps in the Current Adapter

These are gaps relative to the gold-standard `wiki/` content — close them in
priority order before promising "your repo will produce a great KB":

| # | Gap | Symptom | Fix sketch |
|---|---|---|---|
| 1 | YAML frontmatter is **stripped, not consumed**. | `tags`, `type`, `sources` set in `wiki/` frontmatter never reach `tags`/columns; only directory tags survive. | Parse frontmatter → merge YAML `tags` into chunk `tags`; persist `type`/`sources` into a JSONB metadata column. Migration adds `metadata JSONB` to `document_embeddings`. |
| 2 | Wikilinks `[[page]]` survive into chunk text as literal noise. | Embeddings carry `[[admin-api]]` tokens; retrieval matches the punctuation, not the concept. | Pre-process wikilinks → replace with the link target's title (or strip brackets). Tracked alongside (1). |
| 3 | Code chunks are line-windowed, not symbol-aware. | Function signatures split mid-body. TSDoc separated from the function it documents. | New `CodeChunker` using tree-sitter (already flagged in `DefaultChunker.ts` as future work) — split at function/class boundaries, keep doc-comment + signature + body together. |
| 4 | No file-priority weighting. | A `README.md` chunk and a deep utility chunk score equally on cosine similarity. Generic queries surface utility code. | Multiply embedding score by a path-based prior at retrieval time (README ≫ docs/ ≫ src/) or store a `priority` column. |
| 5 | No language-aware filter for code-as-docs. | `.json` files (e.g. `tsconfig.json`) get chunked and indexed. They contribute almost no semantic signal. | Tighten default `include` to skip `tsconfig.json`, `package.json` `engines`/`scripts`, etc., or extract only specific keys. |
| 6 | Diagram images (`.png`, `.svg`, embedded Mermaid in `.md`) are not OCR'd or parsed. | Visual architecture diagrams disappear from retrieval; only their captions survive. | Out of scope short-term. Mitigate by **always pairing diagrams with prose** that names every node and edge. |
| 7 | No project manifest — multi-repo apps have no graph. | A user with `frontend`, `backend`, `infra` repos has three disconnected indexes. The chatbot cannot answer "how does the frontend reach the backend?" without the user phrasing the cross-repo question explicitly. | Add a `.tucaken.yml` (or read `package.json#repository` siblings) that names related repos at root. Persist a `project_id` column joining them. See §7. |
| 8 | No README-aware boost. | `README.md` is treated as one more `.md`. | At ingest, set `metadata.is_readme = true` for files matching `(^|/)README\.(md\|mdx)$`. Use as a retrieval prior. |
| 9 | `*.test.ts` excluded — but test files often contain the **best examples** of how an API is used. | "How do I call ingestChunks?" — the test file shows it; the test file is excluded. | Optional include pattern, opt-in. Keeps default tight while letting power users harvest examples. |
| 10 | Truncated tree fallback is sequential (one API request per directory). | Repos > ~100K tree entries can spend hours fetching. | Parallelize subtree fetches with a small semaphore (3–5). Already noted in `GitHubAdapter.ts`. |

**Pick order to ship:** (1)+(2) together (parsing frontmatter + wikilinks) is
the highest *content quality* lift. (3) is the highest *code-question quality*
lift. (8)+(4) are easy and large retrieval wins. (7) unlocks the multi-repo
story (next section).

---

## 7. Multi-Repo End-to-End Applications

### 7.1 Today's behaviour

The chunk identity is `(user_id, repo_full_name, file_path, chunk_index)`. All
of a user's repos write into the same `document_embeddings` table under the
same `user_id`. **Retrieval already crosses repo boundaries** — a vector query
returns the top-K chunks regardless of which repo each came from.

So the *naïve* multi-repo case works:

> User connects `acme/frontend`, `acme/backend`, `acme/infra`. They ask "how
> does the frontend authenticate to the backend?" Cosine similarity surfaces
> the README sections from `frontend` and `backend` that mention auth, plus
> the `infra` ADR for the JWT issuer.

It is not great — but it is functional. Each chunk's `repo_full_name` and
`file_path` are returned alongside the content, so the answer can be cited
correctly.

### 7.2 Where it falls short

1. **No notion of "this is one application."** Two unrelated users could each
   have their own `frontend/backend/infra` triple under the same
   `user_id` — they all blend together.
2. **No edges between repos.** "Service A calls service B" is implicit in code
   only. There's no graph for the retrieval layer to walk; each chunk is an
   island connected only by lexical overlap.
3. **Conflicting names.** Two repos with the same `Article` type — embeddings
   collide. Both surface; neither is preferred.
4. **No project-level summary.** A query like "summarize the architecture of
   *Acme*" has no canonical chunk to anchor on; it gets a soup of READMEs.

### 7.3 Recommended evolution

**Step 1 (small, ships fast):** add a `project_id` column to
`document_embeddings`. Populate from a `.tucaken.yml` at the root of each repo:

```yaml
# .tucaken.yml
project: acme
repos:
  - acme/frontend
  - acme/backend
  - acme/infra
```

When ingesting, the worker:
- reads `.tucaken.yml` from each connected repo,
- writes `project_id = "acme"` on every chunk it produces,
- accepts a `project_id` filter in retrieval, so the chatbot can answer
  *"within Acme, how does the frontend talk to the backend?"* without
  cross-tenant bleed.

**Step 2 (richer):** synthesise a per-project summary at ingestion completion.
Concatenate every repo's root README + module READMEs, run one LLM call to
produce a `<project>-overview.md` chunk tagged `['project','overview']` and
flagged `metadata.synthesized = true`. This is exactly the page
`portfolio-research-brain/wiki/projects/<name>.md` is by hand.

**Step 3 (graph, future):** parse imports/manifests across repos
(`package.json#dependencies` for siblings, `helm` chart `dependencies`,
`docker-compose.yml` services) to materialise an *application graph*. Store as
edges in a side table; let retrieval re-rank chunks whose chunks-of-origin
are graph-adjacent to the query's best hit.

The Tucaken end-state described in the brief — *"users connect their existing
project repos and whatever documentation lives there gets ingested"* — is
fully achievable on Step 1. Step 2 is what makes the chatbot answer feel
authored. Step 3 is differentiation.

---

## 8. The First Ingestion Test

Before promising ingestion quality, run this exact flow:

1. **Target repo:** `Nelson-Lamounier/portfolio-research-brain`.
2. **Constrain to `wiki/`** (extend `FileFilter` with an `include: ['wiki/**']`
   override, or run with that one path scoped). This keeps the test focused
   on content the adapter can actually do something with.
3. **Run** `applications/ingestion/run-ingestion.ts` with `forceReindex=true`.
4. **Expected outcome (rough):** 70–90 markdown files → ~400–700 chunks, all
   with non-empty headings, average chunk length ~800–1500 chars,
   `total_chunks` per file mostly between 4 and 12.
5. **Validation queries** (run after ingestion completes):

   ```sql
   -- Coverage: every wiki sub-tag should be represented
   SELECT tags[1] AS top_tag, COUNT(*)
   FROM document_embeddings
   WHERE repo_full_name = 'Nelson-Lamounier/portfolio-research-brain'
   GROUP BY 1 ORDER BY 2 DESC;
   ```
   (You should see `['wiki']` first, then sub-tags `concepts`, `projects`, etc.)

   ```sql
   -- Chunk size health
   SELECT
     percentile_cont(0.5) WITHIN GROUP (ORDER BY length(content)) AS p50,
     percentile_cont(0.95) WITHIN GROUP (ORDER BY length(content)) AS p95,
     MIN(length(content)), MAX(length(content))
   FROM document_embeddings;
   ```
   (p50 around 1000–1400, p95 < 2200, max < 2200 — anything above means a
   section escaped paragraph splitting.)

   ```sql
   -- Heading hygiene — no chunk should have NULL/empty heading from a markdown file
   SELECT COUNT(*) FILTER (WHERE heading IS NULL) AS no_heading,
          COUNT(*) FILTER (WHERE heading = '')   AS empty_heading
   FROM document_embeddings
   WHERE file_type IN ('md','mdx');
   ```

6. **Smoke retrieval** with three known-answer questions:
   - *"What is the BFF pattern used in admin-api?"* → expect chunks from
     `wiki/projects/admin-api.md` (specifically the H2 sections under "Route
     Map" and "Cross-Cutting Concerns").
   - *"How are CDK Kubernetes stacks organized?"* → expect chunks from
     `wiki/concepts/cdk-kubernetes-stacks.md`.
   - *"Why did SSM permission-denied errors happen on `/data/app-deploy`?"* →
     expect chunks from `wiki/troubleshooting/ssm-permission-denied.md`.

   If those three queries don't surface the right sources in the top-3 hits,
   the chunker / retrieval is not where it needs to be — fix that before
   targeting customer repos.

---

## 9. Quick Reference — Repo Owner Checklist

Print this. Tape it next to the keyboard.

```
ROOT
[ ] README.md exists, ≤ 1500 chars per H2 section, covers:
    What it does · Architecture (Mermaid) · Runtime contract ·
    Repo layout · How to run · Deploy · Related repos · Glossary
[ ] .tucaken.yml lists sibling repos that form one app   (when supported)
[ ] No narrative content under dist/ build/ generated-*
[ ] Files > 500 KB are not narrative docs

DOCS
[ ] docs/ split into concepts/, decisions/, troubleshooting/, patterns/
[ ] One concept per file, kebab-case filenames
[ ] H2/H3 split each page into clearly-titled, self-contained sections
[ ] Each H2 section ≥ 1 paragraph, ≤ 2000 chars
[ ] No load-bearing content inside YAML frontmatter
[ ] Mermaid diagrams accompanied by prose naming the nodes/edges
[ ] Cross-links use plain markdown, not wikilinks (until adapter learns to resolve them)

CODE
[ ] TSDoc/JSDoc on every exported symbol — purpose · contract · failure modes
[ ] 4-line module-purpose comment at the top of each non-trivial file
[ ] No essay-length doc-comments duplicating the README
[ ] Test files excluded (default) — examples live in docs/ instead

VALIDATION
[ ] Ingest wiki/-style repo first; run the §8 SQL + smoke queries
[ ] Re-ingest after every structural change for ~6 weeks; watch p95 chunk size
```

---

## 10. Summary

The adapter today is a competent **markdown-first ingester** with a code
fallback. It will produce a high-quality KB *if and only if* the source repo
is structured for chunk-level retrieval: short concept-scoped markdown files,
H2/H3-driven sections, directory-as-taxonomy, prose that names every diagram
node, TSDoc on every exported symbol, and no narrative buried in
generated-output folders.

For your first end-to-end test, point it at
`portfolio-research-brain/wiki/`. That repo *is* the gold-standard customer
output — feeding it to the ingester closes the loop and tells you whether the
pipeline is honest before any real customer connects a real repo.

The biggest unlocks beyond that are: parsing YAML frontmatter into searchable
metadata (gap 1), a tree-sitter code chunker (gap 3), and a `.tucaken.yml`
project manifest so multi-repo apps stop being three disconnected indexes
(gap 7 / §7).
