# Feature Specification: Skill Vocabulary Expansion

**Feature Branch**: `feat/skill-vocabulary-expansion`

**Created**: 2026-06-19

**Status**: Draft

**Input**: User description: "Expand the skill-canonicalisation vocabulary beyond the 75-row hand-seed so the existing resolver collapses the long tail of skill phrases to stable canonicals, using only commercially-safe sources."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Long-tail skill phrases resolve to stable canonicals (Priority: P1)

A candidate's repositories and a job description both describe the same capability in many different words ("autoscaling groups", "auto scaling group config", "aws auto scaling"). Today the matcher only collapses phrases that fall near one of 75 hand-seeded canonicals, so most phrases stay raw and the two sides fail to overlap. With a comprehensive vocabulary, the resolver maps the large majority of these phrases onto shared canonical labels, so the candidate's evidence and the job's requirements meet on the same terms.

**Why this priority**: This is the entire purpose of the feature — it converts a working-but-starved resolver into one that materially improves resume-to-JD matching. Without it, the resolver (already shipped) delivers only a fraction of its value.

**Independent Test**: Re-run enrichment on a reference repository and measure the share of skill-taggings that land on a canonical, plus the resolution eval (recall/precision over alias positives); both must improve substantially over the current baseline.

**Acceptance Scenarios**:

1. **Given** the expanded vocabulary is loaded and embedded, **When** a repository is re-enriched, **Then** a substantially larger share of its skill-taggings resolve to canonicals than the 28-of-75 / ~534-tagging baseline.
2. **Given** a job description and a candidate repository describing the same capability in different words, **When** both are canonicalised, **Then** they resolve to the same canonical and the overlap match succeeds.

---

### User Story 2 - Vocabulary is commercially safe and auditable (Priority: P1)

The product is a commercial SaaS, so every vocabulary entry must come from a source whose licence permits commercial reuse. An operator can audit the vocabulary and confirm the legal basis of every canonical.

**Why this priority**: A licence violation is an existential risk that cannot be remediated after the fact — it must be a constraint from the first import, not a later cleanup. Equal priority to P1 because shipping an unsafe vocabulary is worse than shipping none.

**Independent Test**: Query the vocabulary for any entry whose recorded source is not on the approved commercial-safe list; the result must be empty.

**Acceptance Scenarios**:

1. **Given** the import runs, **When** it encounters a source that forbids commercial use (e.g. Lightcast), **Then** that source is excluded and no entries from it are written.
2. **Given** the vocabulary is loaded, **When** an operator inspects any canonical, **Then** its source and licence provenance are recorded and reusable for commercial use.

---

### User Story 3 - Existing curation is preserved and de-duplicated (Priority: P2)

The current 75 hand-curated canonicals + their aliases encode real product knowledge and must survive the expansion. At the same time, the seed contains a handful of near-duplicate canonicals that should be merged so the resolver does not ambiguously collapse genuinely distinct skills.

**Why this priority**: Protects existing quality and removes a known precision risk, but is secondary to having a large vocabulary at all.

**Independent Test**: After import, confirm every pre-existing curated canonical and alias is still present and resolvable; confirm the known near-duplicate pairs now share a single canonical.

**Acceptance Scenarios**:

1. **Given** the seed's 75 canonicals + aliases, **When** the expansion completes, **Then** all of them remain present and resolvable.
2. **Given** two near-duplicate canonicals (e.g. "cross-functional partnership" and "cross-functional collaboration"), **When** the import de-duplicates, **Then** one canonical remains and the other becomes an alias of it.

---

### Edge Cases

- What happens when an imported source label collides with an existing curated canonical? The curated entry wins; the import attaches the source label as an alias rather than creating a duplicate.
- How does the system handle a phrase that matches no canonical even after expansion? It stays raw (the resolver's existing fail-open behaviour) — the long tail shrinks but is never required to be empty.
- What happens when the public source updates? The import is re-runnable and reconciles additions/changes without duplicating existing canonicals.
- How does the larger vocabulary affect the similarity threshold? If denser canonicals reduce separation, the existing resolution eval re-tunes the threshold; the import must not silently degrade precision.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST import a comprehensive capability vocabulary from a commercially-reusable, attribution-only public source into the canonical skill ontology.
- **FR-002**: The system MUST import a technology/tool vocabulary from authoritative, commercially-reusable package-registry sources for tool-level canonicals.
- **FR-003**: The system MUST support the project's own curated additions for skills and technologies absent from public sources (the fast-moving engineering tail).
- **FR-004**: Every imported canonical MUST be embedded through the existing backfill so the existing resolver can match against it — no new resolution mechanism is introduced.
- **FR-005**: The import MUST be idempotent and re-runnable: re-running reconciles new/changed source entries without creating duplicate canonicals.
- **FR-006**: The import MUST de-duplicate near-identical canonicals by keeping one canonical and demoting the others to aliases — including the known near-duplicate soft-skill canonicals in the current seed.
- **FR-007**: The system MUST exclude any source whose licence forbids commercial use; no entries from such sources may be written.
- **FR-008**: The import MUST preserve every pre-existing curated canonical and alias (no regression of hand-curated quality); on collision, the curated entry is authoritative.
- **FR-009**: Each imported canonical MUST record its source and licence provenance so the vocabulary's legal basis is auditable.
- **FR-010**: After expansion, the resolution eval (recall/precision over alias positives) MUST be re-runnable so any precision regression from the larger vocabulary is detected before the vocabulary is relied upon.

### Key Entities *(include if feature involves data)*

- **Canonical skill**: a preferred-label capability or technology, with a category, an active flag, and source + licence provenance. Distinct entries represent genuinely distinct skills.
- **Alias**: an alternate surface form pointing to exactly one canonical (preferred/alternate-label model). De-duplication and collision handling both produce aliases.
- **Vocabulary source**: a provenance record describing where a batch of canonicals/aliases came from and under what licence (capability source, technology-registry source, or curated).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: The share of corpus skill-taggings that resolve to a canonical increases substantially above the current baseline (28 of 75 canonicals exercised, ~534 canonical taggings on the reference repository) after re-enrichment.
- **SC-002**: The resolution eval's recall over alias positives holds or improves versus the 75-seed baseline, with no drop in precision (no new false merges introduced by the larger vocabulary).
- **SC-003**: The vocabulary contains zero entries from non-commercial-licence sources, verifiable by provenance query.
- **SC-004**: Re-running the import produces no duplicate canonicals (count of canonicals is stable across identical re-runs).
- **SC-005**: 100% of the pre-existing curated canonicals and aliases remain present and resolvable after expansion.
- **SC-006**: The known near-duplicate canonical pairs in the seed are reduced to a single canonical each, removing the identified false-merge risk.

## Assumptions

- The existing embedding backfill and nearest-canonical resolver are reused unchanged; the vocabulary is the only new input (the resolver is already a working socket, proven on the live end-to-end run).
- The capability primary source is O*NET (Creative Commons Attribution 4.0 — commercial use with attribution); ESCO is deferred as an optional EU-alignment facet, not part of this feature.
- The technology layer is canonicalised against package registries (npm, PyPI, and similar) rather than a labour-market taxonomy, which is more authoritative for tools.
- Lightcast Open Skills is excluded: "open" there means transparent, not openly licensed; commercial use requires a paid contract.
- The similarity threshold validated previously (0.62) is the starting point; the existing resolution eval re-tunes it only if the denser vocabulary measurably reduces canonical separation.
- Vocabulary scale targets the capability + tool layers relevant to software-engineering evidence (thousands of canonicals), not the entire occupational taxonomy — breadth is bounded to what improves coverage without diluting precision.
- The import is an operator/maintenance job (reference data, not user-scoped); it does not run on the user request path.
