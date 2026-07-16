# Projects Narrative Quality Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tier-weighted theme activation (required JD boxes outrank concept noise) and a four-beat, public-vocabulary narrative contract for composed project bullets with a generic deterministic style guard -- production-ready for ANY JD and ANY user.

**Architecture:** Spec docs/superpowers/specs/2026-07-16-projects-narrative-quality-design.md. Two tasks: T1 = Component 1 (tier activation, incl. generality evals); T2 = Components 2-4 (persona/message contract, style guard + repair routing, observability, style/generality evals).

**Tech Stack:** TypeScript, jest, existing lanes (no new LLM calls; the style repair rides the EXISTING single projects rewrite).

## Global Constraints

- Branch `feat/projects-narrative-quality` (exists). ONE commit per task, impact-bullet body, no Co-Authored-By.
- Gates per task: full `yarn workspace @bedrock/job-strategist test` green (growth only from 158 suites / 1435 tests), `tsc --noEmit`, ROOT `yarn eslint <changed files>` (NEW functions complexity <= 10), ASCII-only added lines, UK English.
- NEVER `git stash`. Fail-open everywhere (style findings NEVER reject; tier-mapping degradation to 'preferred'). GENERALITY: no hardcoded user skills/repos/identifiers/JD names anywhere in implementation code; lint = generic patterns only; at least one non-infrastructure JD eval.
- Untouched: buildProjectPool, projects-provenance validation rules, keyword-match.ts, summary-coverage.ts. Persona: version bump + manifest regeneration via the prompt-content-integrity suite.

---

### Task 1: tier-weighted theme activation

**Files:**
- Modify: `applications/job-strategist/src/agents/evidence/operations-themes.ts` (+ its test), `applications/job-strategist/src/agents/evidence/operations-wiring.ts` + `run-pipeline.ts` `jdStringsForThemes` (single flattening source becomes tier-aware)
- Test/evals: `evals/projects/operations-evidence-graders.*` tier + generality cases

**Interfaces (Produces):**
```ts
export interface TieredJdString { readonly text: string; readonly tier: 'disqualifying' | 'required' | 'preferred'; }
export function activateThemes(jdStrings: readonly TieredJdString[]): OperationsTheme[];
// score(theme) = sum over DISTINCT matched jd strings of weight(tier): disqualifying=3, required=2, preferred=1;
// sort DESC, ties by ontology order; MAX_ACTIVATED_THEMES = 4.
// Caller mapping (jdStringsForThemes): hardRequirements[].skill w/ disqualifying=true -> 'disqualifying',
// other hardRequirements -> 'required', preferredSkills + concepts -> 'preferred'; missing fields -> 'preferred' (fail-open, documented).
```

- [ ] **Step 1:** failing tests: MongoDB-TSE-shaped tiered strings (networking as a required box) -> networking-protocols activates within cap 4; a data-engineering JD (disqualifying "ETL pipelines"/database strings, preferred storage concepts) activates by tier not by raw concept count; frontend-only JD -> ZERO (no-op intact); tie-break + cap + distinct-string counting preserved; untier'd degradation ('preferred') covered.
- [ ] **Step 2:** implement + migrate the single caller; gates; commit `feat(job-strategist): tier-weighted operations theme activation (required boxes outrank concept noise)`

### Task 2: narrative contract + style guard + observability + evals

**Files:**
- Create: `applications/job-strategist/src/agents/writer/projects-style.ts` (+ test)
- Modify: `prompts/content/strategist/projects-agent.md` (four-beat contract + 3 hard style rules + jargon-preference rule; version bump + manifest), `agents/writer/projects-message.ts` (contract restated in the runtime message; style findings context in the rewrite message), `agents/writer/projects-ats-flow.ts` + `run-pipeline.ts` (compute findings beside validation; feed into the EXISTING single rewrite call; advisory violations `composed_style_violation` stage `projects_style`; diag style {composedFindings, curatedAdvisories}), `agents/writer/projects-agent-diagnostics.ts` (Loki `projects_style_findings`), `docs/runbooks/projects-agent-observability.md`
- Test/evals: style-guard unit tests + eval cases (c)-(d) from the spec

**Interfaces:**
```ts
// projects-style.ts -- GENERIC patterns only, no allow/blocklists
export interface StyleFinding { readonly kind: 'internal_identifier' | 'bare_plus_numeric' | 'code_call'; readonly token: string; }
export function checkComposedBulletStyle(text: string): StyleFinding[];
// internal_identifier: /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g ; bare_plus_numeric: /\b\d+(?:k|m)?\+/gi ; code_call: /\b[a-zA-Z_]\w*\(\)/g
// Unintroduced-acronym detection deliberately OUT OF SCOPE for the lint (persona-only rule) -- document.
```

- [ ] **Step 1:** failing tests: "(RETRIEVAL_PREFILTER)" -> internal_identifier; "100+" and "12k+" -> bare_plus_numeric; "sanitizeMdx()" -> code_call; clean four-beat bullet -> []; findings computed for composed bullets only, curated -> advisory counter only; repair routing: findings present -> the ONE existing rewrite call receives them, valid clean output ships, invalid output ships ORIGINAL + advisories (never fallback).
- [ ] **Step 2:** implement + wire + persona/message + runbook; gates; commit `feat(job-strategist): composed-bullet narrative contract + generic style guard (advisory, repair-routed)`

---

## Self-Review

**Spec coverage:** C1 -> T1 (weights/cap/caller + generality evals a-b); C2 -> T2 persona/message; C3 -> T2 guard + routing + curated exemption; C4 -> T2 diag/Loki/runbook + evals c-d. Generality constraint restated in Global Constraints and pinned by eval (b). **Placeholder scan:** clean -- regexes, weights, cap, codes, stages concrete. **Type consistency:** TieredJdString/StyleFinding names consistent; activateThemes signature change confined to the single flattening caller.
