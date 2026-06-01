# Stage-Prep Reference Ontology — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the global, frozen stage-prep reference ontology (4 tables + seed + repository + selection logic) that supplies structural constraints to interview-prep LLM agents.

**Architecture:** Mirror `migrations/046_project_ontology.sql` exactly — global reference tables (no `user_id`, no RLS), seeded inside the migration via idempotent `INSERT ... ON CONFLICT DO UPDATE`, frozen snapshot with cited provenance. A typed `RdsStagePrepOntologyRepository` (in `applications/shared`) exposes reads with a `'*'` sentinel fallback. **Data layer only** — prompt injection + Coach wiring belong to Spec 2 (Phone Screen).

**Tech Stack:** PostgreSQL (pgvector image), TypeScript, `pg`, Jest (with `fakePool` mock pattern). Migrations run by `platform-rds-bootstrap`'s lexicographic `runBootstrap`.

**Spec:** `docs/superpowers/specs/2026-06-01-stage-prep-ontology-design.md`

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `applications/platform-rds-bootstrap/migrations/049_stage_prep_ontology.sql` | DDL for 4 tables + full seed, frozen snapshot | Create |
| `applications/shared/src/stage-prep/stage-prep-types.ts` | TS types for the 4 ontology entities + enums | Create |
| `applications/shared/src/stage-prep/role-family.ts` | `targetRole` string → `RoleFamily`; seniority→comp enum maps (pure) | Create |
| `applications/shared/src/stage-prep/role-family.test.ts` | Unit tests for the mapping functions | Create |
| `applications/shared/src/stage-prep/index.ts` | Barrel export for the module | Create |
| `applications/shared/src/rds/implementations/RdsStagePrepOntologyRepository.ts` | Typed reads w/ sentinel fallback | Create |
| `applications/shared/src/rds/implementations/RdsStagePrepOntologyRepository.test.ts` | `fakePool` unit tests | Create |
| `applications/shared/src/index.ts` | Re-export the new repository + types | Modify |

**Conventions to follow (verified in repo):**
- Repository files start with `/** @format */`, take `private readonly pool: Pool`, map snake_case rows → camelCase via a `toX()` helper. (See `RdsProjectOntologyRepository.ts`.)
- Tests use `import { describe, it, expect, jest } from '@jest/globals';` and the `fakePool(rowsBySql)` helper that matches SQL by regex. (See `RdsProjectOntologyRepository.test.ts`.)
- Imports use `.js` extensions (ESM/NodeNext).
- Migration header cites `Source:` + `Frozen snapshot: a future upstream change is a new migration.` (See `046_project_ontology.sql`.)

---

## Task 1: Migration DDL — 4 tables (no seed yet)

**Files:**
- Create: `applications/platform-rds-bootstrap/migrations/049_stage_prep_ontology.sql`

- [ ] **Step 1: Write the DDL with header**

Create the file with exactly this content:

```sql
-- 049_stage_prep_ontology.sql
--
-- Seeds the interview stage-prep ontology as GLOBAL reference data
-- (no user_id, no RLS — mirrors project_archetypes / technology_ontology).
-- Supplies structural constraints to interview-prep agents: what a stage tests,
-- question patterns, leadership principles, process shapes, STAR + gap-handling
-- scaffolds, and compensation benchmarks. The LLM fills slots; it never invents them.
--
-- Source: curated 2026-06-01 from public references, each row citing its own `source`:
--   stage_expectations  — Tech Interview Handbook, ByteByteGo, interviewing.io,
--                         Google-SRE guides (Coditioning/IGotAnOffer), roadmap.sh (URLs per row)
--   company profiles    — official Amazon Leadership Principles; Glassdoor (process shapes)
--   comp_benchmarks     — levels.fyi region/level pages + Stack Overflow Developer Survey 2025
--   scaffolds           — canonical STAR/CAR/SAR frameworks; UI-spec gap-handling guidance
-- Frozen snapshot: a future upstream change is a new migration.
--
-- Idempotent: IF NOT EXISTS + INSERT ... ON CONFLICT DO UPDATE.

BEGIN;

CREATE TABLE IF NOT EXISTS stage_expectations (
    id                TEXT PRIMARY KEY,
    company_type      TEXT NOT NULL,
    role_family       TEXT NOT NULL,
    stage             TEXT NOT NULL,
    focus_areas       JSONB NOT NULL DEFAULT '[]'::jsonb,
    question_patterns JSONB NOT NULL DEFAULT '[]'::jsonb,
    expectation_note  TEXT,
    source            TEXT NOT NULL,
    as_of             DATE NOT NULL,
    UNIQUE (company_type, role_family, stage)
);

CREATE TABLE IF NOT EXISTS company_interview_profiles (
    company_key           TEXT PRIMARY KEY,
    display_name          TEXT NOT NULL,
    company_type          TEXT NOT NULL,
    leadership_principles JSONB NOT NULL DEFAULT '[]'::jsonb,
    process_shape         JSONB NOT NULL DEFAULT '[]'::jsonb,
    values_taxonomy       JSONB NOT NULL DEFAULT '[]'::jsonb,
    source                TEXT NOT NULL,
    as_of                 DATE NOT NULL
);

CREATE TABLE IF NOT EXISTS prep_scaffolds (
    id        TEXT PRIMARY KEY,
    kind      TEXT NOT NULL CHECK (kind IN ('story_scaffold','gap_handling')),
    title     TEXT NOT NULL,
    structure JSONB NOT NULL DEFAULT '{}'::jsonb,
    source    TEXT NOT NULL,
    as_of     DATE NOT NULL
);

CREATE TABLE IF NOT EXISTS comp_benchmarks (
    id          TEXT PRIMARY KEY,
    role_family TEXT NOT NULL,
    seniority   TEXT NOT NULL CHECK (seniority IN ('junior','mid','senior','staff','principal')),
    region      TEXT NOT NULL,
    currency    TEXT NOT NULL,
    range_min   INT NOT NULL,
    range_p50   INT NOT NULL,
    range_max   INT NOT NULL,
    source      TEXT NOT NULL,
    as_of       DATE NOT NULL,
    UNIQUE (role_family, seniority, region)
);

COMMIT;
```

- [ ] **Step 2: Verify the SQL parses (no automated migration harness exists)**

Apply against a disposable Postgres. If `DATABASE_URL` points at a dev/local pgvector DB:

Run: `psql "$DATABASE_URL" -f applications/platform-rds-bootstrap/migrations/049_stage_prep_ontology.sql`
Expected: `BEGIN` … four `CREATE TABLE` … `COMMIT` with no error.

If no DB is reachable, at minimum lint the SQL for balanced `BEGIN/COMMIT` and valid syntax by eye, and confirm it loads via the next tasks' inserts.

- [ ] **Step 3: Commit**

```bash
git add applications/platform-rds-bootstrap/migrations/049_stage_prep_ontology.sql
git commit -m "feat(rds): stage-prep ontology tables (migration 049 DDL)"
```

---

## Task 2: Seed `stage_expectations` — 13 web-sourced rows (generic base + overrides)

**Files:**
- Modify: `applications/platform-rds-bootstrap/migrations/049_stage_prep_ontology.sql` (insert seed block before `COMMIT;`)

These 13 rows are transcribed from the 2026-06-01 research pass; every row cites a real source URL. Generic `'*'` rows for all 5 stages, plus FAANG / scaleup / backend / devops overrides only where sources show a genuine difference. Scaleup rows are MODERATE-confidence (sources discuss "startups," extrapolated) — note kept in `source`. No specific questions — only `focus_areas` + question `type`s.

- [ ] **Step 1: Add the seed block** immediately before `COMMIT;`

```sql
-- ── stage_expectations (13 rows, web-sourced 2026-06-01) ───────────
INSERT INTO stage_expectations (id, company_type, role_family, stage, focus_areas, question_patterns, expectation_note, source, as_of) VALUES
('*|*|phone-screen','*','*','phone-screen',
 '["role & motivation fit","background/experience overview","compensation & logistics alignment","communication clarity","basic technical sanity"]'::jsonb,
 '[{"type":"career-arc","prompt_hint":"walk me through your background / what you recently worked on"},{"type":"motivation","prompt_hint":"why this role / why are you looking to move"},{"type":"logistics","prompt_hint":"expectations, timeline, location, compensation range"},{"type":"role-fit-probe","prompt_hint":"specifics about your responsibilities on a past project"}]'::jsonb,
 'A short (15-30 min) recruiter-led filter assessing fit, motivation, and logistics rather than deep technical depth. Coding is generally NOT asked here — it is deferred to the technical screen.',
 'Indeed / RippleMatch / Tech Interview Handbook — indeed.com/career-advice/interviewing/software-engineering-phone-interview-questions; ripplematch.com (recruiter phone-screen guide); retrieved 2026-06-01','2026-06-01'),
('*|*|technical-1','*','*','technical-1',
 '["data structures & algorithms","complexity analysis","coding fluency in a shared editor","edge-case / testing discipline","communicating approach & tradeoffs"]'::jsonb,
 '[{"type":"algorithmic-coding","prompt_hint":"solve a DS&A problem live in a collaborative editor (e.g. CoderPad)"},{"type":"complexity-reasoning","prompt_hint":"state and justify time/space complexity"},{"type":"optimization-followup","prompt_hint":"improve the brute-force / handle a tighter constraint"},{"type":"edge-case-testing","prompt_hint":"test against normal and corner cases"}]'::jsonb,
 'A 30-45 min coding round testing problem-solving, technical competency, communication, and testing. Evaluation weighs HOW you reason and communicate, not just whether the final answer compiles.',
 'Tech Interview Handbook — techinterviewhandbook.org/coding-interview-prep; retrieved 2026-06-01','2026-06-01'),
('*|*|behavioural','*','*','behavioural',
 '["past-performance signals","teamwork & collaboration","conflict resolution","ownership & impact","adaptability / handling ambiguity"]'::jsonb,
 '[{"type":"conflict-story","prompt_hint":"a disagreement with a teammate and how you resolved it"},{"type":"impact-story","prompt_hint":"a high-impact project and your specific role"},{"type":"failure-learning","prompt_hint":"a time something went wrong / what you learned"},{"type":"adaptability","prompt_hint":"a time you pivoted under shifting requirements"}]'::jsonb,
 'Uses past behaviour as a predictor of future performance; answers expected in STAR shape, ~1-2 min each, drawn from a small bank of high-impact stories.',
 'Tech Interview Handbook (behavioural) / MIT CAPD STAR — techinterviewhandbook.org/behavioral-interview; capd.mit.edu/resources/the-star-method-for-behavioral-interviews; retrieved 2026-06-01','2026-06-01'),
('*|*|system-design','*','*','system-design',
 '["requirements clarification","scalability & performance","data modeling & storage","tradeoff reasoning","bottleneck / deep-dive analysis"]'::jsonb,
 '[{"type":"open-ended-design","prompt_hint":"design a well-known product/system from scratch"},{"type":"scale-estimation","prompt_hint":"back-of-the-envelope capacity / QPS / storage"},{"type":"tradeoff-defense","prompt_hint":"justify a choice and name what you sacrifice"},{"type":"deep-dive","prompt_hint":"drill into one component, its bottlenecks and failure modes"}]'::jsonb,
 'An intentionally ambiguous, open-ended design problem with no single right answer; evaluated on thought process, clarifying questions, tradeoff reasoning and communication.',
 'ByteByteGo framework / interviewing.io — bytebytego.com/courses/system-design-interview; interviewing.io/guides/system-design-interview; retrieved 2026-06-01','2026-06-01'),
('*|*|final-round','*','*','final-round',
 '["multiple back-to-back rounds in one loop","coding depth","system/architecture design","behavioural/values fit","cross-round consistency of signal"]'::jsonb,
 '[{"type":"coding-round","prompt_hint":"one or more live algorithmic/coding rounds"},{"type":"design-round","prompt_hint":"a system/architecture design round"},{"type":"behavioural-round","prompt_hint":"a values / collaboration round"},{"type":"deep-experience-probe","prompt_hint":"drill into past work for depth and ownership"}]'::jsonb,
 'The onsite/virtual loop is the last stage before an offer decision — usually several rounds (coding, system design, behavioural) over a few hours, designed to triangulate a consistent signal.',
 'Tech Interview Handbook — techinterviewhandbook.org/software-engineering-interview-guide; retrieved 2026-06-01','2026-06-01'),
('faang|*|technical-1','faang','*','technical-1',
 '["medium-to-hard DS&A","optimization under follow-ups","edge-case handling","clean code","verbal reasoning of tradeoffs"]'::jsonb,
 '[{"type":"leetcode-style-coding","prompt_hint":"medium/hard algorithmic problem in a shared editor"},{"type":"optimization-followup","prompt_hint":"first correct solution is table stakes — optimize and discuss tradeoffs after"},{"type":"edge-case-probe","prompt_hint":"handle corner cases the interviewer surfaces"}]'::jsonb,
 'At FAANG the first correct solution is the baseline, not the goal; differentiation happens in the follow-up conversation (optimization, edge cases, tradeoffs). Bar has risen in 2024-2026.',
 'BeTopTen / DesignGurus FAANG guides — betopten.com/blog/what-to-expect-in-a-faang-onsite-interview; designgurus.io (FAANG 2025 prep); retrieved 2026-06-01','2026-06-01'),
('faang|*|behavioural','faang','*','behavioural',
 '["company-specific values/principles","navigating ambiguity","ownership","intellectual humility / disagreement","user & business impact"]'::jsonb,
 '[{"type":"principle-mapped-story","prompt_hint":"a story that maps to a specific named company principle"},{"type":"ambiguity-navigation","prompt_hint":"a time you operated without clear direction"},{"type":"disagreement","prompt_hint":"how you disagreed-and-committed / handled conflict"}]'::jsonb,
 'FAANG behavioural rounds map explicitly to named value frameworks (e.g. Amazon LPs evaluated across every round; Google Googleyness & Leadership). Stories should be pre-mapped to those principles.',
 'BeTopTen / Medium (Amazon LPs 2026) — betopten.com/blog/what-to-expect-in-a-faang-onsite-interview; retrieved 2026-06-01','2026-06-01'),
('faang|*|final-round','faang','*','final-round',
 '["4-6 back-to-back rounds in one day","two coding rounds","system design (often at lower levels now)","values/leadership round","bar-raiser / cross-calibration"]'::jsonb,
 '[{"type":"dual-coding-rounds","prompt_hint":"typically two separate medium/hard coding rounds"},{"type":"system-design-round","prompt_hint":"design round testing engineering judgment, not textbook recall"},{"type":"values-round","prompt_hint":"company-specific leadership/values round, sometimes embedded in coding rounds"}]'::jsonb,
 'The loop is 4-6 rounds of 45-60 min in a single day, ~2 coding + 1 system design + 1 behavioural. 2024-2026: system design now appears at mid-levels and some loops permit AI tools — confirm format with the recruiter.',
 'BeTopTen / DesignGurus — betopten.com/blog/what-to-expect-in-a-faang-onsite-interview; designgurus.io; retrieved 2026-06-01','2026-06-01'),
('scaleup|*|technical-1','scaleup','*','technical-1',
 '["practical/applied coding over pure DS&A","shipping feature-style code","working in a real environment","raw coding ability","pragmatism"]'::jsonb,
 '[{"type":"practical-build","prompt_hint":"build a small app / endpoint / feature live"},{"type":"take-home","prompt_hint":"a time-boxed (~2-3 hr) assignment resembling real work"},{"type":"lightweight-dsa","prompt_hint":"DS&A may appear but carries weaker hiring signal than at big tech"}]'::jsonb,
 'Smaller/scaling companies weight practical coding ability over algorithm puzzles and more often use practical-build rounds or short take-homes. MODERATE confidence: sources discuss startups/small companies, "scaleup" extrapolated.',
 'Tech Interview Handbook / YC Startup Job Guide — techinterviewhandbook.org; ycombinator.com/library/F2-interviewing-at-a-startup; retrieved 2026-06-01 (extrapolated to scaleup)','2026-06-01'),
('scaleup|*|final-round','scaleup','*','final-round',
 '["shorter, more focused loop","practical/applied work","team & culture fit","ability to ramp fast","breadth/ownership"]'::jsonb,
 '[{"type":"practical-round","prompt_hint":"applied coding or pairing on a realistic task"},{"type":"culture-fit","prompt_hint":"team fit and ways-of-working with founders/leads"},{"type":"experience-deep-dive","prompt_hint":"depth on past delivery and end-to-end ownership"}]'::jsonb,
 'Scaleups favor shorter, tighter loops and emphasize whether you can ramp and ship, plus culture fit, versus FAANG''s longer standardized loop. MODERATE confidence: extrapolated from startup sources.',
 'Jason Pearson (scaling-startup interview design) / Tech Interview Handbook — jasonpearson.dev; techinterviewhandbook.org; retrieved 2026-06-01 (extrapolated to scaleup)','2026-06-01'),
('*|backend|system-design','*','backend','system-design',
 '["API design (REST, statelessness, versioning)","databases (SQL vs NoSQL, replication, indexing)","caching & eviction strategies","concurrency & consistency (locking, CAP)","scaling (load balancing, queues, sharding)"]'::jsonb,
 '[{"type":"api-design","prompt_hint":"design the API surface and resource model for a service"},{"type":"data-modeling","prompt_hint":"choose and justify a storage engine + schema; replication/indexing"},{"type":"concurrency-control","prompt_hint":"optimistic vs pessimistic locking; consistency under contention"},{"type":"scaling-tradeoff","prompt_hint":"introduce caching/queues/sharding and defend the tradeoffs"}]'::jsonb,
 'Backend design rounds center on data and service concerns: API contracts, SQL/NoSQL choice, caching, concurrency/consistency, scaling. Knowing when to use what and the tradeoffs matters more than internals depth.',
 'roadmap.sh backend / SystemDesignHandbook — roadmap.sh/questions/backend; systemdesignhandbook.com; retrieved 2026-06-01','2026-06-01'),
('*|devops|technical-1','*','devops','technical-1',
 '["Linux/OS internals (processes, signals, memory)","networking (TCP/IP, DNS, OSI)","CI/CD & IaC (pipelines, Terraform/Ansible)","containers & orchestration (Docker, Kubernetes)","scripting (Bash/Python)"]'::jsonb,
 '[{"type":"systems-internals","prompt_hint":"explain an OS/Linux concept and its failure/performance implications"},{"type":"scripting-task","prompt_hint":"write a practical script/utility, often without an IDE"},{"type":"k8s-scenario","prompt_hint":"troubleshoot or scale a Kubernetes workload"},{"type":"networking-reasoning","prompt_hint":"reason about traffic along a path; pick the right diagnostic tool"}]'::jsonb,
 'DevOps/SRE technical rounds emphasize hands-on systems depth (Linux, networking, containers, scripting) and reasoning about behaviour, performance and failure modes — not memorized commands.',
 'Coditioning Google SRE / DevOps-Interview-Questions — coditioning.com/blog/17/google-sre-interview-questions; github.com/NotHarshhaa/DevOps-Interview-Questions; retrieved 2026-06-01','2026-06-01'),
('*|devops|system-design','*','devops','system-design',
 '["non-abstract/operationally-feasible design (NALSD)","reliability & failure modes","hypothesis-driven troubleshooting","monitoring & observability","capacity/migration strategy"]'::jsonb,
 '[{"type":"nalsd-design","prompt_hint":"design a concrete, operable production system (capacity, monitoring, failure modes)"},{"type":"troubleshooting-scenario","prompt_hint":"given a failing system, debug it systematically"},{"type":"migration-design","prompt_hint":"migrate/evolve a system without breaking reliability"}]'::jsonb,
 'DevOps/SRE design splits into Non-Abstract Large System Design (feasible, operable, tied to monitoring/failure modes) and a distinct troubleshooting round assessing structured, hypothesis-driven debugging.',
 'Coditioning / IGotAnOffer Google SRE — coditioning.com/blog/17/google-sre-interview-questions; igotanoffer.com/blogs/tech/google-site-reliability-engineer-interview; retrieved 2026-06-01','2026-06-01')
ON CONFLICT (company_type, role_family, stage) DO UPDATE SET
    focus_areas=EXCLUDED.focus_areas, question_patterns=EXCLUDED.question_patterns,
    expectation_note=EXCLUDED.expectation_note, source=EXCLUDED.source, as_of=EXCLUDED.as_of;
```

> **Curation note:** these 13 are the full sourced set. `phone-screen` has no FAANG/scaleup/role override because sources show the recruiter screen is role- and company-type-agnostic — the generic `'*'` row governs (proven by the sentinel fallback). Do not invent overrides the research didn't support.

- [ ] **Step 2: Re-apply migration, verify rows load**

Run: `psql "$DATABASE_URL" -f applications/platform-rds-bootstrap/migrations/049_stage_prep_ontology.sql && psql "$DATABASE_URL" -c "SELECT count(*) FROM stage_expectations;"`
Expected: count = 13, no error (idempotent re-run succeeds).

- [ ] **Step 3: Commit**

```bash
git add applications/platform-rds-bootstrap/migrations/049_stage_prep_ontology.sql
git commit -m "feat(rds): seed stage_expectations (generic base + overrides)"
```

---

## Task 3: Seed `company_interview_profiles` — leadership principles + process shapes

**Files:**
- Modify: `applications/platform-rds-bootstrap/migrations/049_stage_prep_ontology.sql`

- [ ] **Step 1: Add the seed block** before `COMMIT;` (after Task 2's block)

```sql
-- ── company_interview_profiles ─────────────────────────────────────
INSERT INTO company_interview_profiles (company_key, display_name, company_type, leadership_principles, process_shape, values_taxonomy, source, as_of) VALUES
('amazon','Amazon','faang',
 '[{"name":"Customer Obsession","description":"Start with the customer and work backwards."},{"name":"Ownership","description":"Act on behalf of the entire company, beyond just your own team."},{"name":"Invent and Simplify","description":"Seek new ideas and find ways to simplify."},{"name":"Are Right, A Lot","description":"Strong judgment and good instincts; seek diverse perspectives."},{"name":"Learn and Be Curious","description":"Never stop learning; explore new possibilities."},{"name":"Hire and Develop the Best","description":"Raise the performance bar with every hire and promotion."},{"name":"Insist on the Highest Standards","description":"Continually raise the bar; drive quality up."},{"name":"Think Big","description":"Create and communicate a bold direction that inspires results."},{"name":"Bias for Action","description":"Speed matters; many decisions are reversible."},{"name":"Frugality","description":"Accomplish more with less; constraints breed resourcefulness."},{"name":"Earn Trust","description":"Listen attentively, speak candidly, treat others respectfully."},{"name":"Dive Deep","description":"Operate at all levels, stay connected to details, audit frequently."},{"name":"Have Backbone; Disagree and Commit","description":"Challenge respectfully, then commit fully once decided."},{"name":"Deliver Results","description":"Focus on key inputs and deliver them with the right quality and on time."},{"name":"Strive to be Earth''s Best Employer","description":"Create a safer, more productive, more empathetic work environment."},{"name":"Success and Scale Bring Broad Responsibility","description":"Be humble; consider the broader consequences of our work."}]'::jsonb,
 '[{"stage":"phone-screen","format":"recruiter screen","note":"Fit + logistics + comp alignment"},{"stage":"technical-1","format":"technical phone (coding)","note":"One coding problem, LP probing begins"},{"stage":"final-round","format":"onsite loop (4-5)","note":"Coding, system design, behavioural — every round scored against LPs"}]'::jsonb,
 '[]'::jsonb,
 'Amazon Leadership Principles (official, amazon.jobs)','2026-06-01'),
('stripe','Stripe','scaleup',
 '[]'::jsonb,
 '[{"stage":"phone-screen","format":"recruiter screen","note":"Fit + role interest"},{"stage":"technical-1","format":"technical phone","note":"Practical coding close to real product work"},{"stage":"final-round","format":"onsite (4 rounds)","note":"2 coding, 1 system design, 1 behavioural"}]'::jsonb,
 '[{"name":"Users first","description":"Optimise for the long-term success of users."},{"name":"Move with urgency and focus","description":"Bias to ship, sequence ruthlessly."}]'::jsonb,
 'Glassdoor Stripe interview reports (aggregated)','2026-06-01')
ON CONFLICT (company_key) DO UPDATE SET
    display_name=EXCLUDED.display_name, company_type=EXCLUDED.company_type,
    leadership_principles=EXCLUDED.leadership_principles, process_shape=EXCLUDED.process_shape,
    values_taxonomy=EXCLUDED.values_taxonomy, source=EXCLUDED.source, as_of=EXCLUDED.as_of;
```

> **Curation note:** Amazon's 16 LPs are public + finite — seeded verbatim. Add Meta + Google profiles following the identical shape (values_taxonomy for those that publish values rather than named principles). Process shapes are structural (the *shape*, not the questions). Keep `source` honest; mark any inferred process shape as Glassdoor-aggregated.

- [ ] **Step 2: Verify**

Run: `psql "$DATABASE_URL" -f applications/platform-rds-bootstrap/migrations/049_stage_prep_ontology.sql && psql "$DATABASE_URL" -c "SELECT company_key, jsonb_array_length(leadership_principles) FROM company_interview_profiles;"`
Expected: `amazon | 16`, `stripe | 0` (Stripe uses values_taxonomy), no error.

- [ ] **Step 3: Commit**

```bash
git add applications/platform-rds-bootstrap/migrations/049_stage_prep_ontology.sql
git commit -m "feat(rds): seed company_interview_profiles (LPs + process shapes)"
```

---

## Task 4: Seed `prep_scaffolds` — STAR/CAR/SAR + gap-handling templates

**Files:**
- Modify: `applications/platform-rds-bootstrap/migrations/049_stage_prep_ontology.sql`

- [ ] **Step 1: Add the seed block** before `COMMIT;`

```sql
-- ── prep_scaffolds ─────────────────────────────────────────────────
INSERT INTO prep_scaffolds (id, kind, title, structure, source, as_of) VALUES
('star','story_scaffold','STAR',
 '{"steps":[{"key":"situation","label":"Situation","prompt":"Set the context and constraints."},{"key":"task","label":"Task","prompt":"Your specific responsibility or goal."},{"key":"action","label":"Action","prompt":"What YOU did — concrete, first-person."},{"key":"result","label":"Result","prompt":"Measurable outcome and what you learned."}]}'::jsonb,
 'STAR method (widely documented behavioural framework)','2026-06-01'),
('car','story_scaffold','CAR',
 '{"steps":[{"key":"context","label":"Context","prompt":"Situation and challenge together."},{"key":"action","label":"Action","prompt":"What YOU did."},{"key":"result","label":"Result","prompt":"Outcome and impact."}]}'::jsonb,
 'CAR method (behavioural framework variant)','2026-06-01'),
('sar','story_scaffold','SAR',
 '{"steps":[{"key":"situation","label":"Situation","prompt":"Context and problem."},{"key":"action","label":"Action","prompt":"What YOU did."},{"key":"result","label":"Result","prompt":"Outcome."}]}'::jsonb,
 'SAR method (behavioural framework variant)','2026-06-01'),
('gap-adjacent-pivot','gap_handling','Acknowledge gap, pivot to adjacent strength',
 '{"trigger":"red_evidence_for_topic","template":"I have not used {missing} in production, but I have used {adjacent} which solves the same class of problem — {adjacent_evidence}. Here is how I''d ramp on {missing}: {ramp_plan}."}'::jsonb,
 'UI spec \"Be honest\" guidance (gap-handling)','2026-06-01'),
('gap-recent-learning','gap_handling','Frame a gap as recent, deliberate learning',
 '{"trigger":"amber_evidence_for_topic","template":"I''ve been deliberately ramping on {topic} recently — {recent_evidence}. I''m not claiming deep production scars yet, but here''s my current working understanding: {grounded_summary}."}'::jsonb,
 'UI spec \"Be honest\" guidance (gap-handling)','2026-06-01')
ON CONFLICT (id) DO UPDATE SET
    kind=EXCLUDED.kind, title=EXCLUDED.title, structure=EXCLUDED.structure,
    source=EXCLUDED.source, as_of=EXCLUDED.as_of;
```

- [ ] **Step 2: Verify**

Run: `psql "$DATABASE_URL" -f applications/platform-rds-bootstrap/migrations/049_stage_prep_ontology.sql && psql "$DATABASE_URL" -c "SELECT kind, count(*) FROM prep_scaffolds GROUP BY kind;"`
Expected: `gap_handling | 2`, `story_scaffold | 3`.

- [ ] **Step 3: Commit**

```bash
git add applications/platform-rds-bootstrap/migrations/049_stage_prep_ontology.sql
git commit -m "feat(rds): seed prep_scaffolds (STAR variants + gap-handling)"
```

---

## Task 5: Seed `comp_benchmarks` — sourced starter set

**Files:**
- Modify: `applications/platform-rds-bootstrap/migrations/049_stage_prep_ontology.sql`

**Data honesty (from research pass):** levels.fyi's free pages give real percentiles but only for **generic "Software Engineer"**, not per-role, in EU/UK — so those rows use `role_family='*'` and resolve via the repository's `'*'` fallback (Task 8). Only **US** has real role-split data (Stack Overflow 2025 medians: backend/devops/data). All levels.fyi figures are **total comp** (incl. US equity); SO figures are self-reported total comp — each row's `source` states this. EU proxy = Germany (EUR). Cells with no reliable free data (frontend, ml/data outside US, staff) are deliberately omitted, not fabricated.

- [ ] **Step 1: Add the seed block** before `COMMIT;`

```sql
-- ── comp_benchmarks (web-sourced 2026-06-01; generic rows use role_family '*') ──
-- TOTAL COMP, not base. levels.fyi US numbers are equity-loaded. Flag in PR for user vet.
INSERT INTO comp_benchmarks (id, role_family, seniority, region, currency, range_min, range_p50, range_max, source, as_of) VALUES
-- EU (Germany proxy) + UK: generic SWE only — role_family '*'
('*|mid|eu-remote','*','mid','eu-remote','EUR',68400,82467,100000,'levels.fyi Software Engineer Germany overall (generic SWE, all-level aggregate as mid proxy), TOTAL comp, retrieved 2026-06-01','2026-06-01'),
('*|senior|eu-remote','*','senior','eu-remote','EUR',80647,93794,114300,'levels.fyi Senior Software Engineer Germany (generic SWE, not role-specific), TOTAL comp, retrieved 2026-06-01','2026-06-01'),
('*|mid|uk','*','mid','uk','GBP',60300,87820,127000,'levels.fyi Software Engineer United Kingdom overall (generic SWE, all-level aggregate as mid proxy), TOTAL comp, retrieved 2026-06-01','2026-06-01'),
('*|senior|uk','*','senior','uk','GBP',86057,114206,161094,'levels.fyi Senior Software Engineer United Kingdom (generic SWE, not role-specific), TOTAL comp, retrieved 2026-06-01','2026-06-01'),
-- US: generic senior (levels.fyi real percentiles) + role-split mid medians (Stack Overflow 2025)
('*|senior|us','*','senior','us','USD',176250,250000,355699,'levels.fyi Senior Software Engineer United States (generic SWE), TOTAL comp incl. equity, retrieved 2026-06-01','2026-06-01'),
('backend|mid|us','backend','mid','us','USD',175000,175000,175000,'Stack Overflow Developer Survey 2025 (US back-end median; single median only), total comp, retrieved 2026-06-01','2026-06-01'),
('devops|mid|us','devops','mid','us','USD',165000,165000,165000,'Stack Overflow Developer Survey 2025 (US DevOps median; single median only), total comp, retrieved 2026-06-01','2026-06-01'),
('data|mid|us','data','mid','us','USD',150000,150000,150000,'Stack Overflow Developer Survey 2025 (US data-engineer median; single median only), total comp, retrieved 2026-06-01','2026-06-01')
ON CONFLICT (role_family, seniority, region) DO UPDATE SET
    currency=EXCLUDED.currency, range_min=EXCLUDED.range_min, range_p50=EXCLUDED.range_p50,
    range_max=EXCLUDED.range_max, source=EXCLUDED.source, as_of=EXCLUDED.as_of;
```

> **Curation note:** the three US `mid` rows are median-only (SO publishes no per-role percentiles) → `min=p50=max`; Spec 2's UI should render these as a point, not a band. Flag the whole table for user vet in the PR description. Missing combos resolve via the `'*'` fallback or yield null (UI hides the range — never fabricates).

- [ ] **Step 2: Verify**

Run: `psql "$DATABASE_URL" -f applications/platform-rds-bootstrap/migrations/049_stage_prep_ontology.sql && psql "$DATABASE_URL" -c "SELECT count(*) FROM comp_benchmarks;"`
Expected: count = 8.

- [ ] **Step 3: Commit**

```bash
git add applications/platform-rds-bootstrap/migrations/049_stage_prep_ontology.sql
git commit -m "feat(rds): seed comp_benchmarks (sourced starter set)"
```

---

## Task 6: Types module

**Files:**
- Create: `applications/shared/src/stage-prep/stage-prep-types.ts`

- [ ] **Step 1: Write the types**

```typescript
/** @format */

/** Company archetype dimension used by stage_expectations + company profiles. */
export type CompanyType = 'faang' | 'scaleup' | 'series-b' | 'enterprise' | '*';

/** Role family dimension for stage_expectations + comp_benchmarks. */
export type RoleFamily = 'backend' | 'frontend' | 'devops' | 'ml' | 'data' | 'mobile' | '*';

/** Compensation seniority enum (adds 'principal' above the project StageId set). */
export type CompSeniority = 'junior' | 'mid' | 'senior' | 'staff' | 'principal';

export interface QuestionPattern {
    readonly type: string;
    readonly promptHint: string;
}

export interface StageExpectation {
    readonly id: string;
    readonly companyType: string;
    readonly roleFamily: string;
    readonly stage: string;
    readonly focusAreas: string[];
    readonly questionPatterns: QuestionPattern[];
    readonly expectationNote: string | null;
}

export interface LeadershipPrinciple {
    readonly name: string;
    readonly description: string;
}

export interface ProcessStage {
    readonly stage: string;
    readonly format: string;
    readonly note: string;
}

export interface CompanyInterviewProfile {
    readonly companyKey: string;
    readonly displayName: string;
    readonly companyType: string;
    readonly leadershipPrinciples: LeadershipPrinciple[];
    readonly processShape: ProcessStage[];
    readonly valuesTaxonomy: LeadershipPrinciple[];
}

export type ScaffoldKind = 'story_scaffold' | 'gap_handling';

export interface PrepScaffold {
    readonly id: string;
    readonly kind: ScaffoldKind;
    readonly title: string;
    readonly structure: Record<string, unknown>;
}

export interface CompBenchmark {
    readonly id: string;
    readonly roleFamily: string;
    readonly seniority: CompSeniority;
    readonly region: string;
    readonly currency: string;
    readonly rangeMin: number;
    readonly rangeP50: number;
    readonly rangeMax: number;
}
```

- [ ] **Step 2: Typecheck**

Run: `cd applications/shared && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add applications/shared/src/stage-prep/stage-prep-types.ts
git commit -m "feat(shared): stage-prep ontology types"
```

---

## Task 7: Selection logic — role-family + seniority maps (pure, TDD)

**Files:**
- Create: `applications/shared/src/stage-prep/role-family.ts`
- Test: `applications/shared/src/stage-prep/role-family.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from '@jest/globals';
import { toRoleFamily, toCompSeniority } from './role-family.js';

describe('toRoleFamily', () => {
    it('maps common backend titles', () => {
        expect(toRoleFamily('Senior Backend Engineer')).toBe('backend');
        expect(toRoleFamily('Platform / DevOps Engineer')).toBe('devops');
        expect(toRoleFamily('Frontend Developer')).toBe('frontend');
        expect(toRoleFamily('Machine Learning Engineer')).toBe('ml');
    });
    it('falls back to "*" when no keyword matches', () => {
        expect(toRoleFamily('Chief Happiness Officer')).toBe('*');
    });
});

describe('toCompSeniority', () => {
    it('passes through the project StageId set', () => {
        expect(toCompSeniority('junior')).toBe('junior');
        expect(toCompSeniority('mid')).toBe('mid');
        expect(toCompSeniority('senior')).toBe('senior');
        expect(toCompSeniority('staff')).toBe('staff');
    });
    it('defaults null/unknown to "mid"', () => {
        expect(toCompSeniority(null)).toBe('mid');
        expect(toCompSeniority('wizard')).toBe('mid');
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd applications/shared && npx jest src/stage-prep/role-family.test.ts`
Expected: FAIL — `Cannot find module './role-family.js'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
/** @format */
import type { RoleFamily, CompSeniority } from './stage-prep-types.js';

/** Ordered keyword → family. First match wins; devops before backend so "platform" maps right. */
const ROLE_KEYWORDS: ReadonlyArray<readonly [RegExp, RoleFamily]> = [
    [/\b(devops|sre|platform|infra(structure)?|reliability)\b/i, 'devops'],
    [/\b(machine learning|ml engineer|ml\b|mlops|ai engineer)\b/i, 'ml'],
    [/\b(data engineer|data platform|analytics engineer)\b/i, 'data'],
    [/\b(front[- ]?end|react|ui engineer)\b/i, 'frontend'],
    [/\b(mobile|ios|android)\b/i, 'mobile'],
    [/\b(back[- ]?end|server|api|golang|node|java|python engineer)\b/i, 'backend'],
];

export function toRoleFamily(title: string): RoleFamily {
    for (const [re, fam] of ROLE_KEYWORDS) if (re.test(title)) return fam;
    return '*';
}

const COMP_LEVELS: ReadonlySet<string> = new Set(['junior', 'mid', 'senior', 'staff', 'principal']);

export function toCompSeniority(stage: string | null): CompSeniority {
    return stage && COMP_LEVELS.has(stage) ? (stage as CompSeniority) : 'mid';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd applications/shared && npx jest src/stage-prep/role-family.test.ts`
Expected: PASS (all cases). Note: `'Machine Learning Engineer'` matches the `ml` rule before `backend`; `'Platform / DevOps Engineer'` matches `devops` first.

- [ ] **Step 5: Commit**

```bash
git add applications/shared/src/stage-prep/role-family.ts applications/shared/src/stage-prep/role-family.test.ts
git commit -m "feat(shared): role-family + comp-seniority mapping (TDD)"
```

---

## Task 8: Repository with sentinel fallback (TDD, `fakePool`)

**Files:**
- Create: `applications/shared/src/rds/implementations/RdsStagePrepOntologyRepository.ts`
- Test: `applications/shared/src/rds/implementations/RdsStagePrepOntologyRepository.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, jest } from '@jest/globals';
import { RdsStagePrepOntologyRepository } from './RdsStagePrepOntologyRepository.js';

// Sequential fake: returns queued result sets in call order (for fallback testing).
function seqPool(resultSets: unknown[][]) {
    let i = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const query = jest.fn(async () => ({ rows: resultSets[i++] ?? [] }));
    return { pool: { query } as any, query };
}

const EXP_ROW = {
    id: '*|*|phone-screen', company_type: '*', role_family: '*', stage: 'phone-screen',
    focus_areas: ['career arc'], question_patterns: [{ type: 'career-arc', prompt_hint: 'h' }],
    expectation_note: 'note',
};

describe('RdsStagePrepOntologyRepository.getStageExpectation', () => {
    it('returns the exact match on the first query', async () => {
        const { pool, query } = seqPool([[EXP_ROW]]);
        const repo = new RdsStagePrepOntologyRepository(pool);
        const e = await repo.getStageExpectation('faang', 'backend', 'phone-screen');
        expect(e?.questionPatterns[0]).toEqual({ type: 'career-arc', promptHint: 'h' });
        expect(query).toHaveBeenCalledTimes(1); // exact hit, no fallback
    });
    it('falls back to ("*", role, stage) then ("*","*",stage)', async () => {
        const { pool, query } = seqPool([[], [], [EXP_ROW]]); // exact miss, role-only miss, generic hit
        const repo = new RdsStagePrepOntologyRepository(pool);
        const e = await repo.getStageExpectation('faang', 'backend', 'phone-screen');
        expect(e?.stage).toBe('phone-screen');
        expect(query).toHaveBeenCalledTimes(3);
    });
    it('returns null when every tier misses', async () => {
        const { pool } = seqPool([[], [], []]);
        const repo = new RdsStagePrepOntologyRepository(pool);
        expect(await repo.getStageExpectation('faang', 'backend', 'offer')).toBeNull();
    });
});

describe('RdsStagePrepOntologyRepository.getCompBenchmark', () => {
    it('returns an exact role-specific match on the first query', async () => {
        const { pool, query } = seqPool([[{
            id: 'backend|mid|us', role_family: 'backend', seniority: 'mid',
            region: 'us', currency: 'USD', range_min: 175000, range_p50: 175000, range_max: 175000,
        }]]);
        const repo = new RdsStagePrepOntologyRepository(pool);
        const c = await repo.getCompBenchmark('backend', 'mid', 'us');
        expect(c?.rangeP50).toBe(175000);
        expect(c?.currency).toBe('USD');
        expect(query).toHaveBeenCalledTimes(1); // exact hit, no fallback
    });
    it('falls back to role_family "*" when no role-specific row exists', async () => {
        const { pool, query } = seqPool([[], [{
            id: '*|senior|uk', role_family: '*', seniority: 'senior',
            region: 'uk', currency: 'GBP', range_min: 86057, range_p50: 114206, range_max: 161094,
        }]]); // exact miss, generic hit
        const repo = new RdsStagePrepOntologyRepository(pool);
        const c = await repo.getCompBenchmark('backend', 'senior', 'uk');
        expect(c?.roleFamily).toBe('*');
        expect(c?.rangeP50).toBe(114206);
        expect(query).toHaveBeenCalledTimes(2);
    });
    it('does not double-query when role_family is already "*"', async () => {
        const { pool, query } = seqPool([[]]);
        const repo = new RdsStagePrepOntologyRepository(pool);
        expect(await repo.getCompBenchmark('*', 'senior', 'us')).toBeNull();
        expect(query).toHaveBeenCalledTimes(1);
    });
});

describe('RdsStagePrepOntologyRepository.listScaffolds', () => {
    it('maps scaffold rows of a kind', async () => {
        const { pool } = seqPool([[
            { id: 'gap-adjacent-pivot', kind: 'gap_handling', title: 'T', structure: { trigger: 'x' } },
        ]]);
        const repo = new RdsStagePrepOntologyRepository(pool);
        const s = await repo.listScaffolds('gap_handling');
        expect(s[0]).toEqual({ id: 'gap-adjacent-pivot', kind: 'gap_handling', title: 'T', structure: { trigger: 'x' } });
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd applications/shared && npx jest src/rds/implementations/RdsStagePrepOntologyRepository.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
/** @format */
import type { Pool } from 'pg';
import type {
    StageExpectation, CompanyInterviewProfile, PrepScaffold, CompBenchmark, ScaffoldKind,
} from '../../stage-prep/stage-prep-types.js';

interface ExpRow {
    id: string; company_type: string; role_family: string; stage: string;
    focus_areas: string[]; question_patterns: Array<{ type: string; prompt_hint: string }>;
    expectation_note: string | null;
}
interface ProfileRow {
    company_key: string; display_name: string; company_type: string;
    leadership_principles: Array<{ name: string; description: string }>;
    process_shape: Array<{ stage: string; format: string; note: string }>;
    values_taxonomy: Array<{ name: string; description: string }>;
}
interface ScaffoldRow { id: string; kind: ScaffoldKind; title: string; structure: Record<string, unknown>; }
interface CompRow {
    id: string; role_family: string; seniority: string; region: string; currency: string;
    range_min: number; range_p50: number; range_max: number;
}

function toExpectation(r: ExpRow): StageExpectation {
    return {
        id: r.id, companyType: r.company_type, roleFamily: r.role_family, stage: r.stage,
        focusAreas: r.focus_areas ?? [],
        questionPatterns: (r.question_patterns ?? []).map(q => ({ type: q.type, promptHint: q.prompt_hint })),
        expectationNote: r.expectation_note ?? null,
    };
}

const EXP_SQL =
    `SELECT id, company_type, role_family, stage, focus_areas, question_patterns, expectation_note
       FROM stage_expectations WHERE company_type = $1 AND role_family = $2 AND stage = $3`;

export class RdsStagePrepOntologyRepository {
    constructor(private readonly pool: Pool) {}

    /** Exact → ('*', role, stage) → ('*','*', stage) → null. */
    async getStageExpectation(companyType: string, roleFamily: string, stage: string): Promise<StageExpectation | null> {
        const tiers: Array<[string, string, string]> = [
            [companyType, roleFamily, stage],
            ['*', roleFamily, stage],
            ['*', '*', stage],
        ];
        const seen = new Set<string>();
        for (const [ct, rf, st] of tiers) {
            const key = `${ct}|${rf}|${st}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const r = await this.pool.query<ExpRow>(EXP_SQL, [ct, rf, st]);
            if (r.rows[0]) return toExpectation(r.rows[0]);
        }
        return null;
    }

    async getCompanyProfile(companyKey: string): Promise<CompanyInterviewProfile | null> {
        const r = await this.pool.query<ProfileRow>(
            `SELECT company_key, display_name, company_type, leadership_principles, process_shape, values_taxonomy
               FROM company_interview_profiles WHERE company_key = $1`, [companyKey]);
        const row = r.rows[0];
        if (!row) return null;
        return {
            companyKey: row.company_key, displayName: row.display_name, companyType: row.company_type,
            leadershipPrinciples: row.leadership_principles ?? [],
            processShape: row.process_shape ?? [],
            valuesTaxonomy: row.values_taxonomy ?? [],
        };
    }

    async listScaffolds(kind: ScaffoldKind): Promise<PrepScaffold[]> {
        const r = await this.pool.query<ScaffoldRow>(
            `SELECT id, kind, title, structure FROM prep_scaffolds WHERE kind = $1`, [kind]);
        return r.rows.map(row => ({ id: row.id, kind: row.kind, title: row.title, structure: row.structure ?? {} }));
    }

    /** Exact (role, sen, region) → ('*', sen, region) → null. Free comp data is mostly generic-SWE. */
    async getCompBenchmark(roleFamily: string, seniority: string, region: string): Promise<CompBenchmark | null> {
        const families = roleFamily === '*' ? [roleFamily] : [roleFamily, '*'];
        for (const rf of families) {
            const r = await this.pool.query<CompRow>(
                `SELECT id, role_family, seniority, region, currency, range_min, range_p50, range_max
                   FROM comp_benchmarks WHERE role_family = $1 AND seniority = $2 AND region = $3`,
                [rf, seniority, region]);
            const row = r.rows[0];
            if (row) {
                return {
                    id: row.id, roleFamily: row.role_family, seniority: row.seniority as CompBenchmark['seniority'],
                    region: row.region, currency: row.currency,
                    rangeMin: row.range_min, rangeP50: row.range_p50, rangeMax: row.range_max,
                };
            }
        }
        return null;
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd applications/shared && npx jest src/rds/implementations/RdsStagePrepOntologyRepository.test.ts`
Expected: PASS (all describe blocks).

- [ ] **Step 5: Commit**

```bash
git add applications/shared/src/rds/implementations/RdsStagePrepOntologyRepository.ts applications/shared/src/rds/implementations/RdsStagePrepOntologyRepository.test.ts
git commit -m "feat(shared): RdsStagePrepOntologyRepository with sentinel fallback (TDD)"
```

---

## Task 9: Barrel exports + full build/test gate

**Files:**
- Create: `applications/shared/src/stage-prep/index.ts`
- Modify: `applications/shared/src/index.ts`

- [ ] **Step 1: Write the module barrel**

`applications/shared/src/stage-prep/index.ts`:

```typescript
/** @format */
export * from './stage-prep-types.js';
export { toRoleFamily, toCompSeniority } from './role-family.js';
```

- [ ] **Step 2: Re-export from the shared package root**

Append to `applications/shared/src/index.ts` (after the existing `./projects/index.js` re-export near line 450):

```typescript
export * from './stage-prep/index.js';
export { RdsStagePrepOntologyRepository } from './rds/implementations/RdsStagePrepOntologyRepository.js';
```

- [ ] **Step 3: Verify the package builds and the full suite is green**

Run: `cd applications/shared && npx tsc --noEmit && npx jest src/stage-prep src/rds/implementations/RdsStagePrepOntologyRepository.test.ts`
Expected: tsc clean; all new tests PASS.

- [ ] **Step 4: Confirm no duplicate-export collisions**

Run: `cd applications/shared && npx jest`
Expected: full shared suite PASS (catches any export-name clash from Step 2).

- [ ] **Step 5: Commit**

```bash
git add applications/shared/src/stage-prep/index.ts applications/shared/src/index.ts
git commit -m "feat(shared): export stage-prep ontology module"
```

---

## Final verification (manual)

- [ ] Apply the full migration to a dev DB and spot-check fallback:

```bash
psql "$DATABASE_URL" -f applications/platform-rds-bootstrap/migrations/049_stage_prep_ontology.sql
psql "$DATABASE_URL" -c "SELECT count(*) FROM stage_expectations;"
psql "$DATABASE_URL" -c "SELECT id FROM stage_expectations WHERE company_type='*' AND role_family='*' AND stage='phone-screen';"
```
Expected: phone-screen generic row present (proves the bottom fallback tier exists).

- [ ] PR description flags the **comp_benchmarks** + any **expectation figures** as starter values pending user vet (per the curation notes).

---

## Notes for the executor

- **No migration test harness** exists in `platform-rds-bootstrap` — correctness of the SQL is verified by applying it to a real Postgres (steps above), and the TypeScript logic is verified by jest. Do not invent a migration test framework.
- **Frozen-snapshot discipline:** never edit seeded rows in a later PR — add a new migration. The `ON CONFLICT DO UPDATE` is for idempotent re-runs of *this* migration, not for content drift.
- **Out of scope (Spec 2):** prompt-injection block builder, Coach Agent wiring, `interview_stages` persistence, Phone Screen UI. Do not build them here — the repository API is the contract Spec 2 consumes.
```