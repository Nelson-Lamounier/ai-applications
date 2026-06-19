# Phase 1 Data Model: Skill Vocabulary Expansion

Reuses the existing `skill_ontology` / `skill_aliases` (092–094) and the shared
import-tracking tables (036). Migration **095** adds licence provenance.

## Entities

### Canonical skill (`skill_ontology`)

The preferred-label capability. Existing columns (092/094) reused; **bold** = added by 095.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | UUID PK | |
| `canonical_name` | TEXT UNIQUE | lowercased preferred label |
| `display_name` | TEXT | human-facing label |
| `category` | TEXT CHECK(15) | `language…cloud,other` (092) |
| `curation_level` | TEXT | `curated` \| `auto_imported` \| `candidate` — imports write `auto_imported`; the 75 seed stays `curated` |
| `source` | TEXT | source name (e.g. `onet`, `curated`) |
| **`source_licence`** | **TEXT** | **e.g. `CC-BY-4.0`, `curated` — drives the SC-003 audit** |
| **`source_url`** | **TEXT** | **provenance link (nullable)** |
| `is_active` | BOOLEAN | de-duplicated-away canonicals set `false` (kept for audit, not deleted) |
| `embedding` | vector(1024) | filled by `backfillSkillEmbeddings` (094) |
| `created_at`/`updated_at` | TIMESTAMPTZ | |

**Validation / rules**
- `canonical_name` unique + lowercased (FR-008 collision → curated wins, import attaches as alias).
- `source_licence` MUST be on the approved commercial-safe list for any row the importer writes (FR-007).
- Distinct rows = genuinely distinct skills; near-duplicates are merged, not co-existing (FR-006).

**State transition (de-duplication)**: when canonical B is a near-duplicate of canonical A → B's aliases re-point to A, B's `canonical_name` becomes an alias of A, B set `is_active = false`. Idempotent: re-running finds B already inactive and skips.

### Alias (`skill_aliases`)

| Column | Type | Notes |
| --- | --- | --- |
| `alias` | TEXT PK | lowercased surface form |
| `skill_id` | UUID FK → skill_ontology | ON DELETE CASCADE |
| `source` | TEXT | where the alias came from |

- Aliases come from: O*NET altLabels, the import collision rule (FR-008), and de-dup (FR-006).
- PK on `alias` enforces one canonical per surface form (no ambiguous alias).

### Import run (`ontology_import_runs`, existing 036)

Reused unchanged — `begin(source, triggeredBy)` / `finish(id, status, counts)`. `counts` is `ImportRunCounts` (fetched/inserted/updated/deactivated/aliasMerges/unresolved/reviewQueueAdded). Gives every skill-import run an auditable record + the SC-001/SC-004 evidence.

### Import source-seen (`ontology_import_sources`, existing 036)

Reused for idempotency: `upsertSeen(skillId, source, sourceIdentifier, …)` tracks what each source has yielded so re-runs reconcile rather than duplicate (FR-005, SC-004). The skill importer scopes its rows by `source` name so it never collides with technology-importer rows.

### Review queue (`ontology_review_queue`, existing 036)

Reused for the 0.70–0.85 dedup grey band (D4) and any L4-unresolved category — human review instead of silent auto-merge.

## Migration 095 (new)

```sql
-- 095_skill_ontology_provenance.sql
ALTER TABLE skill_ontology
    ADD COLUMN IF NOT EXISTS source_licence TEXT,
    ADD COLUMN IF NOT EXISTS source_url     TEXT;

-- Backfill the 75 curated seed as curated/own provenance.
UPDATE skill_ontology SET source_licence = 'curated'
 WHERE source_licence IS NULL AND curation_level = 'curated';

-- Merge the 7 known near-duplicate seed canonicals (D4a): demote to aliases of
-- the kept canonical, re-point aliases, deactivate the duplicate. Deterministic,
-- idempotent (guards on is_active). One block per pair.
-- (cross-functional partnership|leadership -> collaboration; data-driven
--  decisions -> data-driven; user empathy/empathy -> customer empathy)
```

Applied through the checksum ledger (`schema_migrations`); idempotent guards (`IF NOT EXISTS`, `WHERE is_active`) so re-application is a no-op.

## Approved licence allowlist (enforced by the importer + the SC-003 audit)

`CC-BY-4.0` (O*NET), `curated` (own). Anything else is rejected before write. Lightcast and any non-commercial source are absent by construction.
