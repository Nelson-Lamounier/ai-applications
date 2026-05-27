# Tier-1 ProfileExtractor — Design Spec

**Date:** 2026-05-13
**Phase:** 1 of 3 (Unified KB on RDS pgvector)
**Status:** Approved

---

## Goal

Add canonical per-repo structured records to the ingestion pipeline. A `ProfileExtractor` agent (Claude Haiku, forced `tool_use`) synthesises a structured `ExtractedRepoData` record from ~10 GitHub API calls per repo. The result is stored in two new RDS tables and gates the existing chunk pipeline via repo classification.

This is Phase 1 of the three-phase KB unification:
- **Phase 1 (this spec):** Tier-1 profile extraction
- **Phase 2:** Article pipeline Research Agent → pgvector
- **Phase 3:** Chatbot → custom RAG Lambda

---

## Context

Current state: `document_embeddings` in RDS pgvector is the primary knowledge store, fed by the ingestion K8s Job. There is no per-repo structured summary — only raw document chunks. Downstream consumers (chatbot, article pipeline) operate on a flat bag of chunks with no repo-level signal.

Profile extraction adds a structured layer above chunks. Each profile stores:
- Human-quality `one_liner` and `description` for the repo
- Inferred `domain`, `tech_stack`, `role_inferred`, `complexity`
- Up to 5 `highlights` (resume-bullet quality)
- Ground-truth `signals` (has_readme, has_tests, has_ci, etc.)
- A `quality_score` for prioritisation
- A `classification` that gates whether the chunk pipeline runs

---

## Architecture decision: fully integrated (Option A)

ProfileExtractor runs as a pre-step inside `run-ingestion.ts`, not as a separate Job. Reasons:

1. Classification gate must block the chunk pipeline in-process — no polling or RDS read on job start.
2. `FileFetchCache` sharing between ProfileInputCollector and the chunk pipeline eliminates duplicate GitHub API calls for files both paths fetch (e.g. README).
3. Single OTel root span for the whole job.
4. Matches existing `run-ingestion.ts` → orchestrator → pipeline pattern.

---

## Database

### Migration file

`applications/platform-rds-bootstrap/migrations/014_repository_profiles.sql`

> Note: `Implementation.md` references `010_repository_profiles.sql` but migrations currently go up to `013_bedrock_cost_tracking.sql`. Use `014`.

### `repository_profiles`

One row per `(user_id, repo_full_name)`.

```sql
CREATE TABLE repository_profiles (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  repository_id     UUID        REFERENCES repositories(id) ON DELETE CASCADE,
  repo_full_name    TEXT        NOT NULL,
  extracted         JSONB       NOT NULL,
  user_overrides    JSONB       NOT NULL DEFAULT '{}',
  quality_score     NUMERIC(3,2) NOT NULL DEFAULT 0,
  quality_breakdown JSONB       NOT NULL DEFAULT '{}',
  classification    TEXT        NOT NULL DEFAULT 'project'
                               CHECK (classification IN
                                 ('project','fork','tutorial','abandoned','noise','stale')),
  is_featured       BOOLEAN     NOT NULL DEFAULT FALSE,
  feature_rank      INTEGER,
  is_hidden         BOOLEAN     NOT NULL DEFAULT FALSE,
  extraction_status TEXT        NOT NULL DEFAULT 'pending'
                               CHECK (extraction_status IN
                                 ('pending','extracting','ready_for_review','completed','failed')),
  extraction_error  TEXT,
  extracted_at      TIMESTAMPTZ,
  reviewed_at       TIMESTAMPTZ,
  extractor_model   TEXT,
  extractor_version TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, repo_full_name)
);

CREATE INDEX ON repository_profiles (user_id);
CREATE INDEX ON repository_profiles (user_id, feature_rank) WHERE is_featured = TRUE;
CREATE INDEX ON repository_profiles (user_id, classification);
CREATE INDEX ON repository_profiles (extraction_status);
CREATE INDEX idx_repo_profiles_tech_stack
  ON repository_profiles USING GIN ((extracted->'tech_stack'));

CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON repository_profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
```

### `repository_profile_embeddings`

Typed semantic chunks. `chunk_type` is limited to narrative content only — tech_stack is **not** embedded here (see JSONB filtering below).

```sql
CREATE TABLE repository_profile_embeddings (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  profile_id     UUID        NOT NULL REFERENCES repository_profiles(id) ON DELETE CASCADE,
  chunk_type     TEXT        NOT NULL
                             CHECK (chunk_type IN ('one_liner', 'description', 'highlight')),
  content        TEXT        NOT NULL,
  content_hash   TEXT        NOT NULL,
  embedding      vector(1024) NOT NULL,
  metadata       JSONB       NOT NULL DEFAULT '{}',
  last_synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (profile_id, chunk_type, content_hash)
);

CREATE INDEX ON repository_profile_embeddings (user_id);
CREATE INDEX ON repository_profile_embeddings (profile_id);
CREATE INDEX ON repository_profile_embeddings (chunk_type);
CREATE INDEX ON repository_profile_embeddings
  USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
```

### Why no `tech_stack` embedding

Embedding tech stack tokens (e.g. "React, PostgreSQL, Kubernetes") produces noisy vectors — tech names cluster by co-occurrence, not semantic meaning. Faceted filtering via JSONB is exact, fast, and immune to vocabulary mismatch.

```sql
-- Filter: repos using React
WHERE extracted->'tech_stack' @> '["React"]'::jsonb

-- Filter: repos using React AND PostgreSQL
WHERE extracted->'tech_stack' @> '["React","PostgreSQL"]'::jsonb
```

The GIN index on `extracted->'tech_stack'` makes this O(log n).

### RLS + grants

Both tables:
```sql
ALTER TABLE repository_profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY rls_repository_profiles ON repository_profiles
  USING (user_id = current_setting('app.current_user_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON repository_profiles TO tucaken_app;

ALTER TABLE repository_profile_embeddings ENABLE ROW LEVEL SECURITY;
CREATE POLICY rls_repository_profile_embeddings ON repository_profile_embeddings
  USING (user_id = current_setting('app.current_user_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON repository_profile_embeddings TO tucaken_app;
```

---

## ProfileExtractor

**File:** `applications/ingestion/src/agents/ProfileExtractor.ts`

Mirrors `CareerExtractor` from `resume-import-processor`.

### Constructor

```typescript
constructor(
  bedrock: BedrockRuntimeClient,
  modelId: string,
  costTracker: CostTracker,
  extractorVersion?: string,
)
```

### Method: `extract(userId, bundle) → Promise<ExtractedRepoData>`

1. Build system prompt (verbatim from Implementation.md — 8 rules, untrusted content warning)
2. Build user message via `buildPrompt(bundle)` — XML-tagged sections with char caps
3. `ConverseCommand` with `toolConfig.toolChoice = { tool: { name: 'extract_repo_profile' } }`
4. `inferenceConfig: { temperature: 0.1, maxTokens: 2048 }`
5. Parse first `toolUse` block → throw `ProfileExtractionError('no_tool_use_block')` if absent
6. Zod parse with `ExtractedRepoDataSchema` → throw `ProfileExtractionError('schema_validation_failed', zodError)` if invalid
7. **Overwrite `signals` with ground-truth from bundle** (model output ignored for these fields)
8. `costTracker.record({ user_id, model_id, pipeline: 'profile-extraction', input_tokens, output_tokens })`
9. OTel span `profile_extractor.extract` with attrs: `tucaken.repo.full_name`, `tucaken.user.id`, `tucaken.profile.confidence`, `tucaken.profile.domain`, `tucaken.profile.tech_count`, `tucaken.profile.missing_count`

### Signal override (critical)

After Zod validation:
```typescript
extracted.signals = {
  has_readme:       bundle.readme !== null,
  has_tests:        detectTests(bundle),
  has_ci:           Object.keys(bundle.workflows).length > 0,
  has_changelog:    bundle.changelog !== null,
  has_manifest:     Object.keys(bundle.manifests).length > 0,
  commit_count:     bundle.commit_count,
  primary_language: bundle.primary_language,
  last_active_at:   bundle.pushed_at,
};
```

`detectTests(bundle)` checks manifest keys for test scripts (`jest`, `vitest`, `pytest`, `rspec`, etc.) and scans commit messages for `test`/`spec` keywords.

### Zod schema (verbatim from Implementation.md)

```typescript
export const ExtractedRepoDataSchema = z.object({
  project_name:  z.string().min(1).max(120),
  one_liner:     z.string().min(20).max(140),
  description:   z.string().min(40).max(800),
  domain:        z.enum(['web','ml','devops','infra','mobile','data','cli','lib','other']),
  tech_stack:    z.array(z.string()).max(20),
  role_inferred: z.enum(['creator','maintainer','contributor']),
  complexity:    z.enum(['simple','moderate','complex']),
  highlights:    z.array(z.string().max(280)).max(5),
  signals: z.object({
    has_readme:       z.boolean(),
    has_tests:        z.boolean(),
    has_ci:           z.boolean(),
    has_changelog:    z.boolean(),
    has_manifest:     z.boolean(),
    commit_count:     z.number().int().nonneg(),
    primary_language: z.string().nullable(),
    last_active_at:   z.string().nullable(),
  }),
  confidence: z.number().min(0).max(1),
  missing:    z.array(z.string()).default([]),
});
export type ExtractedRepoData = z.infer<typeof ExtractedRepoDataSchema>;
```

### Error class

```typescript
export class ProfileExtractionError extends Error {
  constructor(
    public readonly code: 'no_tool_use_block' | 'schema_validation_failed' | 'bedrock_error',
    message: string,
  ) {
    super(message);
    this.name = 'ProfileExtractionError';
  }
}
```

### Prompt builder constants

```typescript
const MAX_README_CHARS    = 12_000;
const MAX_MANIFEST_CHARS  =  4_000;
const MAX_CHANGELOG_CHARS =  4_000;
const MAX_WORKFLOW_CHARS  =  2_500;
const MAX_COMMITS         =     30;
```

End of user message: `Call extract_repo_profile with your structured analysis. Follow the system rules strictly.`

---

## ProfileInputCollector

**File:** `applications/ingestion/src/agents/ProfileInputCollector.ts`

Single public method: `collect(repoFullName): Promise<ProfileInputBundle>`

Fetches in parallel:
- Repo metadata (existing adapter method)
- README: try `README.md`, `README`, `Readme.md`
- Manifests: `package.json`, `requirements.txt`, `Cargo.toml`, `go.mod`, `pyproject.toml`, `pom.xml`, `Gemfile`
- CHANGELOG: try `CHANGELOG.md`, `CHANGELOG`, `HISTORY.md`
- Workflows: list `.github/workflows/`, fetch up to 5 `.yml`/`.yaml`
- Top 30 commit messages

Error policy: 404 → null. Other errors → log warn, continue. Never throw for a missing file.

### ProfileInputBundle

```typescript
export interface ProfileInputBundle {
  repo_full_name:          string;
  primary_language:        string | null;
  description:             string | null;
  topics:                  string[];
  stars:                   number;
  forks:                   number;
  is_fork:                 boolean;
  created_at:              string | null;
  pushed_at:               string | null;
  commit_count:            number;
  readme:                  string | null;
  manifests:               Record<string, string>;
  changelog:               string | null;
  workflows:               Record<string, string>;
  recent_commit_messages:  string[];
}
```

---

## FileFetchCache

**File:** `applications/ingestion/src/util/FileFetchCache.ts`

```typescript
export class FileFetchCache {
  private cache = new Map<string, string | null>();

  get(path: string): { hit: boolean; value: string | null | undefined } {
    if (this.cache.has(path)) return { hit: true, value: this.cache.get(path) };
    return { hit: false, value: undefined };
  }

  set(path: string, content: string | null): void {
    this.cache.set(path, content);
  }

  clear(): void { this.cache.clear(); }
  size(): number { return this.cache.size; }
}
```

Created once at the top of `run-ingestion.ts`. Passed to both `ProfileInputCollector` and the `GitHubAdapter` wrapper used by the chunk pipeline. Scoped to a single job run — no persistence.

---

## Persistence layer

### RepositoryProfileRepository

**File:** `applications/ingestion/src/repositories/RepositoryProfileRepository.ts`

Constructor: `(pool: Pool)`.

Every method wraps SQL in:
```sql
BEGIN;
SET LOCAL app.current_user_id = $1;
-- SQL here
COMMIT;
```

Methods:
- `upsert(input): Promise<{ id: string }>` — INSERT ON CONFLICT (user_id, repo_full_name) DO UPDATE
- `findByUserAndRepo(userId, repoFullName): Promise<RepositoryProfile | null>`
- `updateStatus(id, status, error?: string): Promise<void>`

### RepositoryProfileEmbeddingsRepository

**File:** `applications/ingestion/src/repositories/RepositoryProfileEmbeddingsRepository.ts`

Constructor: `(pool: Pool)`.

Method: `upsertBatch(rows): Promise<void>` — single multi-row INSERT:

```sql
INSERT INTO repository_profile_embeddings
  (user_id, profile_id, chunk_type, content, content_hash, embedding, metadata)
VALUES ...
ON CONFLICT (profile_id, chunk_type, content_hash) DO UPDATE
  SET embedding = EXCLUDED.embedding,
      last_synced_at = now()
```

`content_hash` = SHA-256 of `content` (computed in TypeScript, not a DB trigger).

---

## Orchestrator integration

**Modify:** `applications/ingestion/src/run-ingestion.ts`

Insert before the existing chunk pipeline:

```
1. const fileCache = new FileFetchCache()
2. const bundle = await profileInputCollector.collect(repoFullName)
3. const { id: profileId } = await profileRepo.upsert({
     user_id, repository_id, repo_full_name,
     extraction_status: 'extracting',
     extractor_model: PROFILE_EXTRACTOR_MODEL_ID,
     extractor_version: profileExtractor.version,
   })
4. try {
     const extracted   = await profileExtractor.extract(userId, bundle)
     const classfn     = classifyRepo(bundle)
     const { score, breakdown } = scoreProfile(extracted, bundle)
     await profileRepo.upsert({ ...fields, extracted, classification: classfn,
       quality_score: score, quality_breakdown: breakdown,
       extraction_status: 'ready_for_review', extracted_at: new Date() })
     await embedProfile(userId, profileId, extracted, pool, embedder)
     await profileRepo.updateStatus(profileId, 'completed')
   } catch (err) {
     await profileRepo.updateStatus(profileId, 'failed', String(err))
     throw err     // job fails → surfaces in K8s job status
   }

5. if (classfn === 'project') {
     await runExistingChunkPipeline(...)   // unchanged; shares fileCache
   } else {
     logger.info({ classification: classfn }, 'skipping_tier2_chunk_pipeline')
   }
```

Profile extraction failure throws → job exits non-zero. Transient Bedrock errors retry on next scheduled run.

### `embedProfile` helper

Emits **3 chunk types only**:

| chunk_type | rows | content |
|---|---|---|
| `one_liner` | 1 | `extracted.one_liner` |
| `description` | 1 | `extracted.description` |
| `highlight` | 0–5 | one per `extracted.highlights[i]` |

No `tech_stack` embedding row. Tech stack lives in `extracted->'tech_stack'` JSONB only.

---

## classifyRepo

**File:** `applications/ingestion/src/util/classifyRepo.ts`

```typescript
export type RepoClassification =
  'project' | 'fork' | 'tutorial' | 'abandoned' | 'noise' | 'stale';

export function classifyRepo(bundle: ProfileInputBundle): RepoClassification {
  if (bundle.is_fork && bundle.commit_count < 5) return 'fork';
  if (bundle.commit_count < 3) return 'abandoned';
  if (/tutorial|hello-world|learning|playground|test-/i.test(bundle.repo_full_name)) {
    return 'tutorial';
  }
  const yearsSincePush = bundle.pushed_at
    ? (Date.now() - new Date(bundle.pushed_at).getTime()) / (365 * 86400 * 1000)
    : Infinity;
  if (yearsSincePush > 5) return 'stale';
  if (!bundle.readme && bundle.commit_count < 10
      && Object.keys(bundle.manifests).length === 0) {
    return 'noise';
  }
  return 'project';
}
```

---

## scoreProfile

**File:** `applications/ingestion/src/util/scoreProfile.ts`

Weighted sum → 0-1:

| Signal | Weight |
|---|---|
| `signals.has_readme` | 0.25 |
| `signals.has_manifest` | 0.20 |
| `signals.has_ci` | 0.15 |
| `signals.has_changelog` | 0.10 |
| `signals.has_tests` | 0.10 |
| `signals.commit_count >= 20` | 0.10 |
| `confidence >= 0.7` | 0.10 |

Returns `{ score: number, breakdown: Record<string, number> }`.

---

## Tests

| File | Cases |
|---|---|
| `agents/__tests__/ProfileExtractor.test.ts` | Valid extraction; `no_tool_use_block` error; `schema_validation_failed` error; signal override (model claims `has_tests: true`, bundle has no manifest → result `has_tests: false`); cost tracker called once with `pipeline: 'profile-extraction'` |
| `util/__tests__/classifyRepo.test.ts` | Table-driven: all 6 classification branches |
| `util/__tests__/scoreProfile.test.ts` | Max score; zero score; partial (3 of 7 signals) |
| `util/__tests__/FileFetchCache.test.ts` | Hit; miss; null caching; clear; size |

All Bedrock and GitHub calls mocked at adapter boundary. No live calls.

---

## New environment variables

| Var | Where | Purpose |
|---|---|---|
| `PROFILE_EXTRACTOR_MODEL_ID` | ingestion K8s Job | Bedrock model id (Haiku EU inference profile) |

---

## Acceptance criteria

- [ ] Migration `014_repository_profiles.sql` applies cleanly against local Postgres + pgvector
- [ ] RLS verified: cross-user query returns zero rows
- [ ] `chunk_type` CHECK only accepts `one_liner`, `description`, `highlight`
- [ ] GIN index on `extracted->'tech_stack'` exists and faceted query uses index scan
- [ ] `ProfileExtractor.extract()` returns valid `ExtractedRepoData` for mocked Bedrock response
- [ ] Signal override: model-provided boolean overwritten by ground-truth from bundle
- [ ] `FileFetchCache` shared between ProfileInputCollector and chunk pipeline (GitHub call count reduced in mock test)
- [ ] Orchestrator writes profile row before chunk pipeline runs
- [ ] Chunk pipeline skipped when `classification !== 'project'`
- [ ] Profile extraction failure: `extraction_status = 'failed'`, job exits non-zero
- [ ] Cost recorded with `pipeline = 'profile-extraction'`
- [ ] OTel span `profile_extractor.extract` linked to K8s job root span
- [ ] All new tests pass; existing ingestion tests unbroken
- [ ] `tsc -b` clean across monorepo
- [ ] Docker image for ingestion builds

---

## Out of scope (Phase 1)

- Gap-fill UI / API for `user_overrides`
- GitHub Issues / PR / Discussion indexing
- Webhook-triggered re-extraction
- Frontend changes
- Backfill scripts for existing repos
- `document_embeddings` modifications
- Resume-import-processor changes
- Bedrock KB / Bedrock Agent retirement
- `PgVectorRetriever` shared component (Phase 2)
- Chatbot custom RAG Lambda (Phase 3)

---

## File map

```
applications/
  platform-rds-bootstrap/
    migrations/
      014_repository_profiles.sql          ← new
  ingestion/
    src/
      agents/
        ProfileExtractor.ts                ← new
        ProfileInputCollector.ts           ← new
        __tests__/
          ProfileExtractor.test.ts         ← new
      repositories/
        RepositoryProfileRepository.ts     ← new
        RepositoryProfileEmbeddingsRepository.ts ← new
      util/
        FileFetchCache.ts                  ← new
        classifyRepo.ts                    ← new
        scoreProfile.ts                    ← new
        __tests__/
          FileFetchCache.test.ts           ← new
          classifyRepo.test.ts             ← new
          scoreProfile.test.ts             ← new
      run-ingestion.ts                     ← modified (FileFetchCache + profile pre-step)
```
