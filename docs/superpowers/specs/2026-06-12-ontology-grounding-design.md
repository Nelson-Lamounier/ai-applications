# Ontology Grounding — Technology Transferability + Role Auto-Training — design

**Date:** 2026-06-12
**Status:** Approved (direction) — spec for build
**Repo:** `ai-applications`. Builds on the Skill Evidence Ledger (#190 — must merge first).

Two production features that close the "the agent doesn't go one layer down" gap proven on run `a52c96fe` (Bedrock/Claude not credited as transferable to OpenAI API; the role-ontology never learns from JD input).

---

## Feature A — Technology Transferability Grounding

**Problem:** the strategist never consults `technology_ontology`. Transferability (Claude↔OpenAI, Bedrock contains Claude, VPC→networking) is left to the LLM's general knowledge → inconsistent; the ATS literal check disqualifies OpenAI API/ChatGPT/Codex despite verified Bedrock/Claude evidence. `technology_relationships` is EMPTY (no reader/writer); `category` IS populated.

### A1. Read the ontology (`TechnologyOntologyRepository`)
- `loadCategoryGroups(): Promise<string[][]>` — `SELECT canonical_name, category FROM technology_ontology WHERE is_active` → group canonical_names by category → arrays (one per category). Coarse transferability: same category ⇒ transferable.
- `loadTransferGroups(): Promise<string[][]>` — connected components over `technology_relationships` (`related_to`/`runs_on`/`part_of`/`implements`), so `aws_bedrock`+`anthropic_claude`+`titan`+`openai`+`chatgpt`+`codex` form ONE transfer group even across categories. Falls back to category groups when relationships are sparse.
- `loadAliasMap()` exists — resolve a JD tool string ("OpenAI API") → canonical (`openai`).

### A2. Seed the relationship graph + missing entities (migration `074_technology_transfer_seed.sql`)
- Add missing entities to `technology_ontology`: `chatgpt`, `codex`, `openai_gpt`, `amazon_titan`, `claude_code` (category `ai_platform`), with aliases.
- Seed `technology_relationships` for the high-value AI/cloud graph (idempotent, `ON CONFLICT DO NOTHING`):
  - hierarchy (`part_of`): `aws_bedrock → aws`, `aws_vpc → aws`; (`runs_on`): `anthropic_claude → aws_bedrock`, `amazon_titan → aws_bedrock`, `chatgpt`/`codex`/`openai_gpt → openai`.
  - transferability (`related_to`): `anthropic_claude ↔ openai`, `aws_bedrock ↔ openai`, `anthropic_claude ↔ openai_gpt`, `claude_code ↔ codex`.
  - This is the curated seed (the user's examples). Broad auto-population of the graph (LLM relationship builder) is a deferred follow-up — the category fallback covers the rest meanwhile.

### A3. ATS transferability tier (`keyword-match.ts`)
- Extend `MatchCtx` with `techGroups?: string[][]` (the transfer/category groups, canonical names).
- New tier `matchTechTransfer(term, resumeText, techGroups, aliasMap)`: resolve the JD term → canonical; resolve resume tokens → canonicals; if the JD term's canonical shares a group with any resume canonical ⇒ match (tier `tech-transfer`). Slots between `ontology` and `embedding` in `matchTerm`.
- `MatchTier` gains `'tech-transfer'`.

### A4. Skill Evidence Ledger — `transferable` via tech group
- `buildSkillEvidenceLedger` gains an optional `techGroups`/`aliasMap`: when a tool has no verified/partial match but its canonical shares a transfer group with a **verified** match's canonical → status `transferable`, `transferableBridge: "same group: <category/relationship> — <verified tech> → <tool>"`. Honesty: only when there IS verified evidence for a group sibling; never for a true gap.

### A5. Matcher persona context (`research-persona.ts` + research-agent)
- Inject a short "Technology transferability (grounded)" block built from the JD tools' transfer groups: e.g. "Bedrock / Claude / Titan / OpenAI API / ChatGPT / Codex are interchangeable LLM-platform skills — credit verified Bedrock/Claude work as transferable to OpenAI API." So the LLM matcher reasons from the GRAPH, not guesswork.

### A6. Wiring (`run-pipeline.ts`)
- Load `techGroups` + `aliasMap` once (fail-open → []); resolve the JD tools; pass `techGroups`/`aliasMap` into `renderCheckAndStoreAts` (→ `matchTerm`) and `buildSkillEvidenceLedger`; build the persona block.

---

## Feature B — Role-Ontology Self-Improving Auto-Training Loop (production)

The loop learns from career history but is blind to JD demand-side signal, uses one quorum for everything, never prunes, has no admin gate. Close all six gaps.

### B1. Learn from the JD (demand-side) — `run-pipeline.ts` + `resolve-role-families.ts`
After role resolution, for each resolved family, stage the JD's `requiredSkills` + `technologyInventory.tools` as `vocabulary` candidates (and novel JD titles as `alias` candidates) against the matched `family_key`, attributed to `ctx.userId`. So the ontology grows from real JD demand, not just the candidate's past. Fail-open.

### B2. Separate quorums + prune (`RoleOntologyRepository.promote`)
- `promote(aliasQuorum, vocabQuorum, familyQuorum)` — vocab/transferable_skill promotion uses `vocabQuorum` (env `ROLE_VOCAB_QUORUM`, default 2), aliases `aliasQuorum` (3), families `familyQuorum` (5).
- After promotion, **prune** candidates that have cleared their quorum (a `DELETE … HAVING COUNT(DISTINCT contributing_user_id) >= q`) so the table stays bounded.

### B3. Quality gate on promoted vocab
- Before appending to `role_ontology.vocabulary`, drop values that are empty, > 60 chars, or already present (the existing `array_append where NOT ANY` plus a length/trim guard). Caps noise from low-quality classifier output.

### B4. Admin candidate-review surface (minimal, prod-trust)
- `RoleOntologyRepository.listCandidates({type, minVotes})` → grouped candidates with vote counts. A read-only admin-api endpoint `GET /admin/role-ontology/candidates` (tucaken admin-api) for an operator to see what's about to promote. Read-only; promotion stays automatic at quorum. (UI is a later follow-up.)

---

## Honesty / safety
- Tech-transfer credit requires REAL verified evidence for a group sibling — never fabricates; true gaps (no sibling evidence) stay gaps.
- The seed graph is curated + idempotent; category fallback is conservative (same-category only).
- The learning loop only STAGES candidates (one vote/user, idempotent); promotion needs cross-user corroboration (quorum) — a single user can't pollute the global ontology.
- All fail-open: ontology/relationship/learning errors never break the pipeline.

## File list
**A (ai-applications):** `migrations/074_technology_transfer_seed.sql`; `TechnologyOntologyRepository.ts` (+loadCategoryGroups/loadTransferGroups); `keyword-match.ts` (techGroups tier); `skill-evidence-ledger.ts` (+ transferable-via-group); `research-persona.ts` + `research-agent.ts` (context block); `run-pipeline.ts` (wiring); tests.
**B (ai-applications):** `RoleOntologyRepository.ts` (promote signature + prune + gate + listCandidates); `resolve-role-families.ts` (vocab quorum arg); `run-pipeline.ts` (stage JD candidates); tests.
**B admin (tucaken):** `admin-api/src/routes/role-ontology-candidates.ts` (read-only endpoint) — separate small PR.

## Testing
- `loadCategoryGroups`/`loadTransferGroups`: grouping + connected-components.
- `matchTechTransfer`: JD "OpenAI API" + resume "Bedrock/Claude" → match; unrelated → no match.
- ledger: transferable-via-group only with verified sibling evidence; gap stays gap (honesty).
- promote: vocabQuorum vs aliasQuorum; prune removes cleared candidates; quality gate drops junk.
- stage-from-JD: requiredSkills/tools staged as vocab candidates for the resolved family.

## Sequencing
Merge #190 first (the ledger is the integration point). Then Feature A + B as one PR (ai-applications), admin endpoint as a small tucaken follow-up. Deferred: LLM auto-population of the full relationship graph; the admin UI.
