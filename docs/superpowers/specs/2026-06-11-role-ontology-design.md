# Role Ontology + Experience Grounding — design

**Date:** 2026-06-11
**Status:** Approved (design) — pending implementation plan
**Repos:** `ai-applications` (ontology, pipeline, persona), `tucaken-app` (admin review surface — Phase 1b, optional)

## Goal

Give the strategist the **role semantics** it currently lacks, so a stretch
candidate's experience is correctly *translated* into the target role's
vocabulary. Concretely: when the user has "Technical Customer Service Associate
@ AWS," the writer must be able to surface SLA / response-time / on-call /
customer-relationship / customer-education / cross-functional-partnership signals
and frame AWS support as SaaS-like customer support — **truthfully**, by
relabelling work the highlights already demonstrate.

## Product context (the resume philosophy this must serve)

This app builds resumes for **stretch candidates** — career changers and recent
graduates who do not meet 100% of the requirement. The structure stays
**reverse-chronological** (functional/skills-based formats are distrusted by both
recruiters and ATS); what changes is **what is load-bearing**: the top third wins
the argument before the eye reaches the chronology.

Two cases, two moves:
- **Career changer** (the primary user's case: marketing → cloud → support + a
  seniority stretch): the gap is *relevance, not quantity*. The move is
  **translation + re-weighting** — every past role rewritten in the target
  domain's vocabulary, projects elevated near the top. **Transferable skills are
  the load-bearing feature** — they are the translation bridge.
- **Recent graduate**: barely any history to re-weight, so **substitution**
  replaces translation (education/projects/coursework lead).

Hard rules the resume obeys: **never name the gap, never apologise**; the job is
to clear the ATS keyword screen, make the differentiator unmissable, and move the
conversation from "years" to "rare capability."

**Scope note:** this spec delivers the **translation engine** (role ontology →
transferable-skills/vocabulary grounding) and the **support archetype**.
Candidate-class *detection* (changer/grad/in-domain) and the translate-vs-
substitute *structural* playbooks are a deliberate **follow-up** (see Out of scope).

## Problem (diagnosed)

- Experience enrichment is a separate `resume-enrichment-processor` Job dispatched
  only after `resume_imports.status='confirmed'`. The test user's import is stuck
  at `ready_for_review` → enrichment never ran → all `user_career_history` rows are
  `enrichment_status='pending'`, `experience_embeddings = 0`.
- The strategist reads experience two ways: `raw_data` structured facts (backend-
  triage-framed highlights) and `experience_embeddings` (semantic). It **never
  reads `enriched_data`**. With embeddings empty, the role semantics never reach
  the writer → the OpenAI run missed SLA/on-call, customer-relationship/education,
  and cross-functional-partnership signals.
- The 6 role archetypes have **no customer-facing/support** archetype; the prompt
  even forbids relabelling "Technical Customer Service Associate" → the writer
  preserves the title but has no lens to frame support work.

## Decisions (locked during brainstorming)

1. **DB-backed, self-improving ontology** (mirror `technology_ontology`), not a static file.
2. **Cascade matching**: deterministic alias-map → cheap Haiku classifier → Tavily online (true last resort).
3. **Learning gate**: `curated > auto_imported > candidate`; user-derived signals land as `candidate` and are promoted to `auto_imported` only when corroborated across **≥ N (default 3) distinct users**.
4. **Transferable-skills-centred**; candidate-class structure deferred to follow-up.

## Data model

Global reference tables (no RLS — like `technology_ontology`).

```sql
CREATE TYPE role_class AS ENUM ('customer_facing','builder','ops','hybrid');
CREATE TYPE curation_level AS ENUM ('curated','auto_imported','candidate');

CREATE TABLE role_ontology (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_key                 TEXT NOT NULL UNIQUE,        -- 'technical-support'
  display_name               TEXT NOT NULL,
  role_class                 role_class NOT NULL,
  canonical_responsibilities TEXT[] NOT NULL DEFAULT '{}',
  vocabulary                 TEXT[] NOT NULL DEFAULT '{}', -- SLA, on-call, customer education…
  transferable_skills        TEXT[] NOT NULL DEFAULT '{}', -- the translation bridge
  industry_notes             TEXT NOT NULL DEFAULT '',     -- "AWS support ≈ SaaS support…"
  curation                   curation_level NOT NULL DEFAULT 'curated',
  popularity_score           INT NOT NULL DEFAULT 0,
  is_active                  BOOLEAN NOT NULL DEFAULT TRUE,
  source                     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE role_aliases (
  alias       TEXT PRIMARY KEY,            -- lowercased title substring
  family_key  TEXT NOT NULL REFERENCES role_ontology(family_key),
  curation    curation_level NOT NULL DEFAULT 'curated',
  source      TEXT NOT NULL DEFAULT 'seed',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE role_learning_candidates (        -- auto-train staging
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_key          TEXT NOT NULL,
  candidate_type      TEXT NOT NULL CHECK (candidate_type IN ('alias','vocabulary','transferable_skill')),
  value               TEXT NOT NULL,
  contributing_user_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (family_key, candidate_type, value, contributing_user_id)  -- one vote per user
);
CREATE INDEX ON role_learning_candidates (family_key, candidate_type, value);
```

## Curated seed (migration)

~15–25 families covering the common engineering/operations/support space. Each
includes role-typical `canonical_responsibilities`, `vocabulary`,
`transferable_skills`, and `industry_notes`. The critical one for the primary user:

```
family_key: 'technical-support'   display: 'Technical Support / Customer Engineering'  role_class: customer_facing
  responsibilities: triage case queues to SLA/response-time targets; on-call rotations;
                    manage customer relationships; educate/enable customers on the platform;
                    drive escalations; partner cross-functionally with product/eng/GTM
  vocabulary: SLA, response time, on-call, queue, ticket, escalation, customer success,
              enablement, onboarding, churn, subscription, account health, SaaS support
  transferable_skills: customer empathy, incident triage, technical communication,
                       stakeholder management, root-cause analysis, documentation
  industry_notes: "AWS/cloud support operates like SaaS support — paying customers,
                   subscriptions, account health; frame infra-provider support as
                   customer-facing SaaS support."
```
Plus: `software-engineer-backend/-frontend/-fullstack`, `sre`, `platform-infra`,
`devops-cloud`, `data-engineering`, `ml-engineering`, `qa-engineering`
(cross-functional partnership vocab), `product`, `customer-success`,
`solutions-engineering`, `security-engineering`, etc. All `curation='curated'`,
`source='seed'`. Title `role_aliases` seeded for each (e.g. `customer service`,
`support engineer`, `service associate` → `technical-support`).

## Matching cascade — `resolveRoleFamilies`

New unit in `@bedrock/shared/rds` (repo + resolver). Per `experience` entry
(`title`, `company`, `highlights`):

```
1. alias-map (in-mem from role_aliases, normalised substring match) → family   [instant]
   → on hit: role_ontology.popularity_score++ (no new learning; curated vocab already good)
2. miss → Haiku forced-tool classifier (title, company, highlights) → { family_key, confidence,
          suggestedVocabulary[], suggestedTransferableSkills[] } derived FROM the user's highlights
   → stage candidates (one vote per (family,value,user) via the UNIQUE constraint):
        • alias  (normalised title → family_key)
        • vocabulary / transferable_skill (each suggested term)
3. family not in role_ontology → Tavily enrichRole (reuse existing enrich-role.ts)
          → synthesise a 'candidate' family + its vocabulary/transferable-skills [last resort]
```

The classifier reading each user's highlights is exactly how *per-user reframing*
is captured: novel titles grow alias coverage, and the vocabulary/transferable-
skill terms users' real phrasing implies become candidates — promoted only on
cross-user corroboration (below). Alias hits (the common, already-curated case)
contribute only popularity.

Returns, per experience: `{ title, company, family_key, role_class, matchVia }`
plus the family's curated+auto_imported `canonical_responsibilities`,
`vocabulary`, `transferable_skills`, `industry_notes` (candidates excluded).

## Grounding — `roleEvidenceBlock`

A new formatted block (sibling of `projectEvidenceBlock`/`educationBlock`), built
in `run-pipeline`'s parallel loads and passed to **research + strategist**. For
each experience it lists the matched family's transferable-skills, vocabulary,
canonical responsibilities, and industry note. Example consumed by the writer:

```
ROLE EVIDENCE (use to TRANSLATE the candidate's real work into the target domain's
vocabulary — never to claim work the highlights don't show):
- Technical Customer Service Associate @ AWS  [customer_facing]
  transferable: customer empathy, incident triage, technical communication, stakeholder mgmt
  vocabulary: SLA, response time, on-call, queue, escalation, customer success, enablement, subscription
  note: AWS support operates like SaaS support — customers, subscriptions, account health.
```

### Persona rules added (strategist-persona.ts)
- **Translate, don't invent:** "Use ROLE EVIDENCE transferable-skills/vocabulary to
  relabel the candidate's actual highlights into the target domain. You may surface
  a vocabulary term ONLY when a highlight demonstrates it; never claim a
  responsibility the highlights don't support."
- **Never name the gap:** "Do not state, explain, or apologise for missing
  experience anywhere in the resume or cover letter."

## Support archetype (piece 2)

Add **archetype 7 — "Technical Support / Customer Engineering"** to the persona
archetype set:
- Triggers: support, customer service, SLA, on-call, escalations, queue/ticketing,
  customer success, technical account, "education on the use of our platforms."
- `leadIdentity`: a support-engineer-who-ships identity; `sectionOrder` leads with
  customer-impact + reliability + the production/AI proof, work history beneath.
- Phase 0 selection: the `roleEvidenceBlock` `role_class` is provided to Phase 0;
  when the candidate's current role is `customer_facing` AND the JD is support-
  flavoured, route here. Selection stays JD-driven.
- Mechanical: `ArchetypeId` `1–6 → 1–7`; clamp `[1..7]` in `extractArchetypeSelection`.

## Auto-training promotion

- Staging happens during `resolveRoleFamilies` (learned aliases + harvested
  vocabulary/transferable-skill terms → `role_learning_candidates`, one vote per
  user via the UNIQUE constraint).
- **Promotion = one idempotent SQL run inline at the end of resolve** (no new
  cron). For each candidate where `COUNT(DISTINCT contributing_user_id) ≥ N`
  (default 3):
  - `alias` → `INSERT INTO role_aliases (..., curation='auto_imported', source='learned') ON CONFLICT DO NOTHING`
  - `vocabulary`/`transferable_skill` → append to the family's array if absent
    (the family's `auto_imported` portion grows).
- `curated` always wins; `auto_imported` only fills gaps; `candidate` is never used
  in grounding. `N` is an env-tunable constant (`ROLE_LEARNING_QUORUM`).

## Guarantees

- **Truthful dashboard:** grounding only enables *relabelling* of demonstrated
  work; the recruiter snapshot still scores against real JD keyword-coverage/gaps,
  so framing improves recall of the right words, not the honest score.
- **RLS:** `role_ontology`/`role_aliases` are global reference data (no RLS).
  `role_learning_candidates` is system-written from the pipeline (which connects as
  `tucaken_app`); grant it write/select without per-user RLS, or own it system-side.
  Verify the pipeline role can write it (it is not user-scoped).
- **Fail-open:** any matching/grounding/learning error degrades to an empty
  `roleEvidenceBlock`; the pipeline never fails because of the ontology.
- **Latency:** alias hits are instant; Haiku only on miss (~3–5s); Tavily only on
  family-miss. Seeded families (incl. the user's three roles) are alias hits.

## Testing

- `resolveRoleFamilies`: alias hit; Haiku-mock on miss + candidate staged;
  Tavily-mock on family-miss; popularity increment; fail-open → empty.
- promotion SQL: <N users → not promoted; ≥N distinct users → promoted; curated
  unaffected; idempotent re-run.
- `roleEvidenceBlock` formatting: correct per-family fields, candidates excluded.
- persona/archetype: archetype 7 selectable; `extractArchetypeSelection` clamps 7;
  the translate/never-name-gap rules present.
- seed migration: `technical-support` family + aliases exist with the SLA/on-call/
  customer-education vocabulary.

## Out of scope (sequenced follow-ups)

1. **Candidate-class detection + structural playbooks** — detect career-changer /
   recent-grad / in-domain (career-history domain vs target + years) and apply the
   translate-vs-substitute structure (project-band elevation, section weighting,
   one-page grad rule). The user will review the current resume-structure
   implementation against the philosophy above and spec this separately.
2. **Fix the post-confirm import-enrichment Job** (un-stick confirmation; make
   Tavily enrichment + `experience_embeddings` run). Lower priority now that the
   inline ontology is the primary path; it becomes a per-user augmentation that
   also feeds candidates into the shared ontology.
3. **Admin review surface** for `candidate` rows (promote/reject) — Phase 1b.

## File list

**ai-applications** (`feat/role-ontology`, off `develop`)
- `applications/platform-rds-bootstrap/migrations/0NN_role_ontology.sql` — tables + enums + curated seed + aliases.
- `applications/shared/src/rds/types/role-ontology.ts` — `RoleFamily`, `RoleMatch`, `RoleEvidence` types.
- `applications/shared/src/rds/implementations/RoleOntologyRepository.ts` — load alias-map, load families, stage candidates, promote.
- `applications/shared/src/rds/ontology/resolveRoleFamilies.ts` — the cascade.
- `applications/job-strategist/src/agents/role-classifier.ts` — Haiku classifier (forced-tool, fail-open).
- `applications/job-strategist/src/agents/role-evidence-block.ts` — format `roleEvidenceBlock`.
- `applications/job-strategist/src/run-pipeline.ts` — parallel load + pass to research/strategist.
- `applications/job-strategist/src/agents/research-agent.ts` + `strategist-agent.ts` — accept the block.
- `applications/job-strategist/src/prompts/strategist-persona.ts` — archetype 7 + translate/never-name-gap rules.
- Reuse: `applications/resume-import-processor/src/bedrock/enrich-role.ts` (Tavily last-resort).
- Tests colocated for each unit.
