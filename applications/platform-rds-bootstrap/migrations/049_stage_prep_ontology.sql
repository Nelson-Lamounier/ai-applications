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
 'UI spec "Be honest" guidance (gap-handling)','2026-06-01'),
('gap-recent-learning','gap_handling','Frame a gap as recent, deliberate learning',
 '{"trigger":"amber_evidence_for_topic","template":"I''ve been deliberately ramping on {topic} recently — {recent_evidence}. I''m not claiming deep production scars yet, but here''s my current working understanding: {grounded_summary}."}'::jsonb,
 'UI spec "Be honest" guidance (gap-handling)','2026-06-01')
ON CONFLICT (id) DO UPDATE SET
    kind=EXCLUDED.kind, title=EXCLUDED.title, structure=EXCLUDED.structure,
    source=EXCLUDED.source, as_of=EXCLUDED.as_of;

-- ── comp_benchmarks (web-sourced 2026-06-01; generic rows use role_family '*') ──
-- TOTAL COMP, not base. levels.fyi US numbers are equity-loaded. Flag in PR for user vet.
INSERT INTO comp_benchmarks (id, role_family, seniority, region, currency, range_min, range_p50, range_max, source, as_of) VALUES
('*|mid|eu-remote','*','mid','eu-remote','EUR',68400,82467,100000,'levels.fyi Software Engineer Germany overall (generic SWE, all-level aggregate as mid proxy), TOTAL comp, retrieved 2026-06-01','2026-06-01'),
('*|senior|eu-remote','*','senior','eu-remote','EUR',80647,93794,114300,'levels.fyi Senior Software Engineer Germany (generic SWE, not role-specific), TOTAL comp, retrieved 2026-06-01','2026-06-01'),
('*|mid|uk','*','mid','uk','GBP',60300,87820,127000,'levels.fyi Software Engineer United Kingdom overall (generic SWE, all-level aggregate as mid proxy), TOTAL comp, retrieved 2026-06-01','2026-06-01'),
('*|senior|uk','*','senior','uk','GBP',86057,114206,161094,'levels.fyi Senior Software Engineer United Kingdom (generic SWE, not role-specific), TOTAL comp, retrieved 2026-06-01','2026-06-01'),
('*|senior|us','*','senior','us','USD',176250,250000,355699,'levels.fyi Senior Software Engineer United States (generic SWE), TOTAL comp incl. equity, retrieved 2026-06-01','2026-06-01'),
('backend|mid|us','backend','mid','us','USD',175000,175000,175000,'Stack Overflow Developer Survey 2025 (US back-end median; single median only), total comp, retrieved 2026-06-01','2026-06-01'),
('devops|mid|us','devops','mid','us','USD',165000,165000,165000,'Stack Overflow Developer Survey 2025 (US DevOps median; single median only), total comp, retrieved 2026-06-01','2026-06-01'),
('data|mid|us','data','mid','us','USD',150000,150000,150000,'Stack Overflow Developer Survey 2025 (US data-engineer median; single median only), total comp, retrieved 2026-06-01','2026-06-01')
ON CONFLICT (role_family, seniority, region) DO UPDATE SET
    currency=EXCLUDED.currency, range_min=EXCLUDED.range_min, range_p50=EXCLUDED.range_p50,
    range_max=EXCLUDED.range_max, source=EXCLUDED.source, as_of=EXCLUDED.as_of;

COMMIT;
