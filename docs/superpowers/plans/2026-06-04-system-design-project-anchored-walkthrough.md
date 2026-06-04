# System Design Project-Anchored Walkthrough Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `system-design` coach stage walk a candidate through their own project concern-by-concern — grounded, honest about gaps — instead of cloning the Technical stage.

**Architecture:** A deterministic pre-step (concern-detection over project evidence + a curated ontology) feeds the existing single-call coach, which emits structured walkthrough cards. A deterministic validator + the existing runtime grounding prevent invention. No new pipeline, no agent-to-agent.

**Tech Stack:** TypeScript (Node16 ESM, `.js` import suffixes), PostgreSQL (pgvector), Jest (ts-jest), Zod, AWS Bedrock Converse (Haiku 4.5, forced tool use), yarn workspaces (`@bedrock/shared`, `@bedrock/job-strategist`).

**Conventions:**
- ESLint enforces `complexity: ['error', 10]` and `@typescript-eslint/consistent-type-imports`. Keep functions small; use `import type`.
- Every file starts with `/** @format */`.
- Run a single test file: `yarn workspace @bedrock/job-strategist test <path>` or `yarn workspace @bedrock/shared test <path>`.
- No `Co-Authored-By` trailers in commits (per project rule).

---

## File Structure

**Create:**
- `applications/platform-rds-bootstrap/migrations/065_system_design_concerns.sql` — ontology table + v1 seed.
- `applications/shared/src/stage-prep/system-design-concerns-types.ts` — concern/detection/card types.
- `applications/shared/src/rds/implementations/RdsSystemDesignConcernRepository.ts` — read-only repo.
- `applications/shared/src/stage-prep/concern-detection.ts` — deterministic detector (+ test).
- `applications/shared/src/stage-prep/system-design-walkthrough.ts` — anti-invention validator (+ test).
- `applications/job-strategist/src/evals/graders/system-design-grader.ts` — walkthrough grader (+ test).

**Modify:**
- `applications/shared/src/stage-prep/index.ts` — export new modules.
- `applications/shared/src/rds/implementations/index.ts` — export new repo (verify barrel path in Task 3).
- `applications/shared/src/strategist-types.ts` — add `systemDesignWalkthrough` + `systemDesignCoverage` to `InterviewCoachResult`.
- `applications/job-strategist/src/agents/coach-agent.ts` — schema/tool/`coachToolForStage`/`buildConcernWalkthroughBlock`.
- `applications/job-strategist/src/prompts/coach/stages/system-design.ts` — rewrite delta.
- `applications/job-strategist/src/prompts/coach/stages/index.ts` — gate split.
- `applications/job-strategist/src/run-coach.ts` — wire detection + validation + coverage.
- `applications/job-strategist/src/evals/graders/stage-focus-grader.ts` (+ `.test.ts`) — move system-design.
- `applications/job-strategist/src/evals/fixtures/system-design.json` — replace with walkthrough fixture.
- `applications/job-strategist/src/evals/coach-evals.test.ts` — register grader.

---

## Task 1: Ontology table + v1 seed (migration 065)

**Files:**
- Create: `applications/platform-rds-bootstrap/migrations/065_system_design_concerns.sql`

- [ ] **Step 1: Write the migration**

Global reference table (no `user_id`, no RLS), idempotent. Seed the v1 concern set. Grounded
where possible against the ai-applications dogfood (RLS, rate-limiting, self-healing infra).

```sql
-- 065_system_design_concerns.sql
-- Curated 2026 system-design interview concern ontology. Global reference data
-- (no user_id, no RLS), frozen snapshot, idempotent re-seed. Mirrors 051_dsa_topics.
BEGIN;

CREATE TABLE IF NOT EXISTS system_design_concerns (
    concern_id              TEXT PRIMARY KEY,
    category                TEXT NOT NULL,
    concern_question        TEXT NOT NULL,
    why_interviewers_ask    TEXT NOT NULL,
    detection_signals       JSONB NOT NULL DEFAULT '[]'::jsonb,
    implementation_patterns JSONB NOT NULL DEFAULT '[]'::jsonb,
    follow_up_questions     JSONB NOT NULL DEFAULT '[]'::jsonb,
    gap_signals             JSONB NOT NULL DEFAULT '[]'::jsonb,
    jd_signal_keywords      JSONB NOT NULL DEFAULT '[]'::jsonb,
    importance              SMALLINT NOT NULL DEFAULT 5,
    source                  TEXT NOT NULL,
    as_of                   DATE NOT NULL
);

INSERT INTO system_design_concerns
    (concern_id, category, concern_question, why_interviewers_ask, detection_signals,
     implementation_patterns, follow_up_questions, gap_signals, jd_signal_keywords, importance, source, as_of) VALUES

('data_isolation_tenant_scoping', 'data_isolation',
 'How do you ensure users cannot access other users'' data?',
 'Multi-tenant data leaks are catastrophic and interviewer-prominent in 2026; tests real authz vs theory.',
 '["row level security","rls","tenant","tenant_id","user_id","scoped query","middleware filter","policy"]'::jsonb,
 '[{"name":"postgres_rls","strengths":["database-enforced","hard to bypass"],"gotchas":["superuser bypass","policy perf"]},{"name":"middleware_query_filter","strengths":["explicit","debuggable"],"gotchas":["easy to forget on new query"]}]'::jsonb,
 '["What if a developer forgets the tenant filter on a new query?","How do you handle admin/support access?","How do you audit cross-tenant access attempts?","How is isolation handled in caches and search indexes?"]'::jsonb,
 '["tenant column present but queries dont filter","middleware present but inconsistent","no tests for isolation"]'::jsonb,
 '["multi-tenant","tenant","data isolation","rls","saas"]'::jsonb, 1, 'curated-2026', '2026-06-04'),

('authn_authz_sessions', 'auth',
 'How do users prove identity and how are permissions enforced?',
 'Auth is the most-probed surface; interviewers test token strategy, session handling, and authz depth.',
 '["oauth","jwt","session","cognito","passkey","magic link","refresh token","rbac","authorization","bearer"]'::jsonb,
 '[{"name":"oauth_oidc_provider","strengths":["offloads identity","standard"],"gotchas":["token lifecycle","logout propagation"]},{"name":"server_session","strengths":["revocable","simple"],"gotchas":["session store scaling"]}]'::jsonb,
 '["How do you rotate refresh tokens?","How do you revoke a compromised session?","How do you enforce least privilege?","Where does authz happen — gateway, service, or DB?"]'::jsonb,
 '["auth present but no revocation","roles checked inconsistently","tokens not rotated"]'::jsonb,
 '["authentication","authorization","oauth","identity","sso","rbac"]'::jsonb, 1, 'curated-2026', '2026-06-04'),

('rate_limiting_dos', 'dos_protection',
 'How do you protect the system from abuse, DoS, and runaway cost?',
 'Cost-based and volumetric abuse are common 2026 probes; tests defense-in-depth thinking.',
 '["rate limit","throttle","token bucket","sliding window","waf","shield","cloudflare","quota","backpressure"]'::jsonb,
 '[{"name":"app_token_bucket","strengths":["fine-grained","per-user"],"gotchas":["distributed counter coordination"]},{"name":"edge_waf","strengths":["absorbs volumetric","off-host"],"gotchas":["coarse","cost"]}]'::jsonb,
 '["Per-user, per-IP, or per-endpoint limiting?","How do you degrade gracefully under load?","How do you prevent a single user blowing up compute cost?","Where is the limiter state stored?"]'::jsonb,
 '["rate limiting present but single-node","no infra-level protection","no cost guardrails"]'::jsonb,
 '["rate limiting","ddos","abuse","throttling","waf","scale"]'::jsonb, 2, 'curated-2026', '2026-06-04'),

('reliability_self_healing', 'reliability',
 'How does the system stay available when components fail?',
 'Seniority signal; interviewers probe retries, circuit breakers, and self-healing posture.',
 '["retry","backoff","circuit breaker","health check","self-healing","failover","graceful degradation","bulkhead","timeout"]'::jsonb,
 '[{"name":"retry_with_backoff","strengths":["handles transient faults"],"gotchas":["retry storms without jitter"]},{"name":"self_healing_controller","strengths":["auto-remediation"],"gotchas":["masking real failures"]}]'::jsonb,
 '["How do you avoid retry storms?","What is your RPO/RTO target?","How do you detect a partial outage?","How do you roll back a bad deploy?"]'::jsonb,
 '["retries without backoff","no circuit breaker","no health checks"]'::jsonb,
 '["reliability","resilience","high availability","failover","sre"]'::jsonb, 3, 'curated-2026', '2026-06-04')

ON CONFLICT (concern_id) DO UPDATE SET
    category=EXCLUDED.category, concern_question=EXCLUDED.concern_question,
    why_interviewers_ask=EXCLUDED.why_interviewers_ask, detection_signals=EXCLUDED.detection_signals,
    implementation_patterns=EXCLUDED.implementation_patterns, follow_up_questions=EXCLUDED.follow_up_questions,
    gap_signals=EXCLUDED.gap_signals, jd_signal_keywords=EXCLUDED.jd_signal_keywords,
    importance=EXCLUDED.importance, source=EXCLUDED.source, as_of=EXCLUDED.as_of;

COMMIT;
```

- [ ] **Step 2: Append the remaining v1 concerns**

Add these rows in the same `VALUES` list, each following the exact column shape above. Fill
`detection_signals`/`implementation_patterns`/`follow_up_questions`/`gap_signals`/`jd_signal_keywords`
the same way (2026-grounded). This completes the v1 set of ~14:

| concern_id | category | concern_question | importance |
|---|---|---|---|
| `api_design_protection` | `api_design` | Why this API style (REST/GraphQL/gRPC), and how is it protected (validation, idempotency, versioning)? | 2 |
| `concurrency_race_conditions` | `concurrency` | How do you handle concurrent mutations and race conditions? | 3 |
| `scaling_stateless_horizontal` | `scaling` | How does the system scale horizontally under load? | 2 |
| `consistency_durability` | `consistency` | Sync vs async writes, eventual consistency, and durability/backup strategy? | 3 |
| `observability_ops` | `observability` | What do you log vs metric vs trace, and how do you alert? | 2 |
| `performance_caching` | `performance` | Caching layers, invalidation, and query/N+1 optimisation? | 3 |
| `cost_management` | `cost` | How do you keep infra cost bounded (right-sizing, autoscaling, free-tier discipline)? | 4 |
| `security_beyond_auth` | `security` | Secret management, encryption at rest/in transit, PII and logging hygiene? | 2 |
| `ai_specific_concerns` | `ai` | Prompt-injection defence, output validation, token cost, RAG grounding? | 2 |
| `data_modeling_storage` | `data_modeling` | How did you choose your data stores and model the schema for access patterns? | 3 |

- [ ] **Step 3: Verify it applies (manual / on next bootstrap)**

Run (only if a dev DB is reachable; otherwise verify syntax by reading):
`psql "$PG_URL" -f applications/platform-rds-bootstrap/migrations/065_system_design_concerns.sql`
Expected: `BEGIN … INSERT 0 14 … COMMIT` with no error. Re-running yields `INSERT 0 14` again (idempotent).

- [ ] **Step 4: Commit**

```bash
git add applications/platform-rds-bootstrap/migrations/065_system_design_concerns.sql
git commit -m "feat(rds): system_design_concerns ontology table + v1 seed (migration 065)"
```

---

## Task 2: Shared types

**Files:**
- Create: `applications/shared/src/stage-prep/system-design-concerns-types.ts`
- Modify: `applications/shared/src/stage-prep/index.ts`

- [ ] **Step 1: Write the types file**

Reuse `EvidenceRef` shape used by skill-transfer (`{source,id,label,fileLine?}`).

```ts
/** @format */

/** A single concern row from the system_design_concerns ontology (migration 065). */
export interface SystemDesignConcern {
  readonly concernId: string;
  readonly category: string;
  readonly concernQuestion: string;
  readonly whyInterviewersAsk: string;
  readonly detectionSignals: string[];
  readonly implementationPatterns: Array<{ name: string; strengths: string[]; gotchas: string[] }>;
  readonly followUpQuestions: string[];
  readonly gapSignals: string[];
  readonly jdSignalKeywords: string[];
  readonly importance: number;
}

/** Evidence pointer cited from real project rows (same shape as skill-transfer). */
export interface ConcernEvidenceRef {
  readonly source: string;   // 'component' | 'decision' | 'stack_item' | 'tag' | 'tech_evidence' | 'dsa_evidence'
  readonly id: string;
  readonly label: string;
  readonly fileLine?: string;
}

export type ConcernStrength = 'strong' | 'partial' | 'none';

/** Per-concern detection result — produced deterministically, never by the model. */
export interface DetectedConcern {
  readonly concernId: string;
  readonly category: string;
  readonly strength: ConcernStrength;
  readonly evidenceRefs: ConcernEvidenceRef[];
  readonly relevantToJd: boolean;
}

/** Coverage map + alignment count for the workspace header. */
export interface ConcernCoverage {
  readonly detected: DetectedConcern[];
  readonly relevantTotal: number;
  readonly relevantAddressed: number;
}

export type FollowUpStatus = 'addressed' | 'partial' | 'gap';

export interface SystemDesignFollowUp {
  readonly question: string;
  readonly status: FollowUpStatus;
  readonly framing: string;
}

/** One walkthrough card emitted by the coach (prose) + grounded evidence (from detection). */
export interface SystemDesignWalkthroughCard {
  readonly concernId: string;
  readonly concernQuestion: string;
  readonly whyItMatters: string;
  readonly evidenceRefs: ConcernEvidenceRef[];
  readonly choiceMade: string | null;
  readonly articulation: string;
  readonly followUps: SystemDesignFollowUp[];
  readonly gapGuidance: string | null;
}
```

- [ ] **Step 2: Export from the stage-prep barrel**

Add to `applications/shared/src/stage-prep/index.ts` (after the `skill-transfer` exports):

```ts
export * from './system-design-concerns-types.js';
```

- [ ] **Step 3: Typecheck**

Run: `yarn workspace @bedrock/shared typecheck`
Expected: no output (success).

- [ ] **Step 4: Commit**

```bash
git add applications/shared/src/stage-prep/system-design-concerns-types.ts applications/shared/src/stage-prep/index.ts
git commit -m "feat(shared): system-design concern + walkthrough types"
```

---

## Task 3: Concern ontology repository

**Files:**
- Create: `applications/shared/src/rds/implementations/RdsSystemDesignConcernRepository.ts`
- Modify: `applications/shared/src/stage-prep/index.ts` (or the rds barrel — verify in Step 2)

- [ ] **Step 1: Write the repository (mirror RdsDsaTopicRepository)**

```ts
/** @format */
import type { Pool } from 'pg';
import type { SystemDesignConcern } from '../../stage-prep/system-design-concerns-types.js';

interface ConcernRow {
  concern_id: string; category: string; concern_question: string; why_interviewers_ask: string;
  detection_signals: string[]; implementation_patterns: SystemDesignConcern['implementationPatterns'];
  follow_up_questions: string[]; gap_signals: string[]; jd_signal_keywords: string[]; importance: number;
}

function toConcern(r: ConcernRow): SystemDesignConcern {
  return {
    concernId: r.concern_id, category: r.category, concernQuestion: r.concern_question,
    whyInterviewersAsk: r.why_interviewers_ask, detectionSignals: r.detection_signals ?? [],
    implementationPatterns: r.implementation_patterns ?? [], followUpQuestions: r.follow_up_questions ?? [],
    gapSignals: r.gap_signals ?? [], jdSignalKeywords: r.jd_signal_keywords ?? [], importance: r.importance ?? 5,
  };
}

/** Read-only repository over the system_design_concerns ontology (migration 065). */
export class RdsSystemDesignConcernRepository {
  constructor(private readonly pool: Pool) {}
  async listConcerns(): Promise<SystemDesignConcern[]> {
    const r = await this.pool.query<ConcernRow>(
      `SELECT concern_id, category, concern_question, why_interviewers_ask, detection_signals,
              implementation_patterns, follow_up_questions, gap_signals, jd_signal_keywords, importance
         FROM system_design_concerns ORDER BY importance, concern_id`);
    return r.rows.map(toConcern);
  }
}
```

- [ ] **Step 2: Export it the way other Rds repos are exported**

Run: `grep -rn "RdsProjectEvidenceRepository" applications/shared/src/index.ts applications/shared/src/rds/`
Find the barrel that re-exports `RdsProjectEvidenceRepository` / `RdsStagePrepOntologyRepository` and add the same line for `RdsSystemDesignConcernRepository`. (If repos are exported individually from `applications/shared/src/index.ts`, add an `export { RdsSystemDesignConcernRepository } from './rds/implementations/RdsSystemDesignConcernRepository.js';` next to the existing repo exports.)

- [ ] **Step 3: Typecheck**

Run: `yarn workspace @bedrock/shared typecheck`
Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add applications/shared/src/rds/implementations/RdsSystemDesignConcernRepository.ts applications/shared/src/index.ts
git commit -m "feat(shared): RdsSystemDesignConcernRepository over the concern ontology"
```

---

## Task 4: Deterministic concern detection (TDD)

**Files:**
- Create: `applications/shared/src/stage-prep/concern-detection.ts`
- Test: `applications/shared/src/stage-prep/concern-detection.test.ts`

Detector contract: for each concern, scan project evidence rows; a row "hits" when its label
shares a token with any of the concern's `detectionSignals`. Tier: a hit from a
`component`/`decision` row → contributes `strong`; `stack_item`/`tag`/repo evidence → `partial`.
`strong` if any strong hit, else `partial` if any hit, else `none`. JD relevance: concern is
`relevantToJd` if any `jdSignalKeywords` token appears in the JD text (or no JD provided → all relevant).

- [ ] **Step 1: Write failing tests**

```ts
/** @format */
import { detectConcernEvidence } from './concern-detection.js';
import type { SystemDesignConcern, ProjectEvidenceInput } from './index.js';

const RLS: SystemDesignConcern = {
  concernId: 'data_isolation_tenant_scoping', category: 'data_isolation',
  concernQuestion: 'q', whyInterviewersAsk: 'w',
  detectionSignals: ['row level security', 'rls', 'tenant'],
  implementationPatterns: [], followUpQuestions: [], gapSignals: [],
  jdSignalKeywords: ['multi-tenant', 'isolation'], importance: 1,
};
const SCALE: SystemDesignConcern = {
  concernId: 'scaling_stateless_horizontal', category: 'scaling',
  concernQuestion: 'q', whyInterviewersAsk: 'w',
  detectionSignals: ['horizontal', 'autoscale', 'stateless'],
  implementationPatterns: [], followUpQuestions: [], gapSignals: [],
  jdSignalKeywords: ['scale'], importance: 2,
};

const evidence: ProjectEvidenceInput = {
  projects: [{ id: 'p1', name: 'Tucaken' }],
  components: [{ id: 'c1', projectId: 'p1', name: 'Tenant RLS policy layer', kind: 'backend' }],
  decisions: [], stackItems: [{ id: 's1', projectId: 'p1', name: 'tenant scoping', category: 'framework' }],
  tags: [], repoEvidence: [],
};

describe('detectConcernEvidence', () => {
  it('marks a concern strong when a component label matches a signal', () => {
    const cov = detectConcernEvidence([RLS], evidence, 'multi-tenant SaaS role');
    const d = cov.detected.find(x => x.concernId === RLS.concernId)!;
    expect(d.strength).toBe('strong');
    expect(d.evidenceRefs.map(r => r.id)).toContain('c1');
    expect(d.relevantToJd).toBe(true);
  });

  it('marks a concern none when no evidence matches', () => {
    const cov = detectConcernEvidence([SCALE], evidence, 'scale role');
    const d = cov.detected.find(x => x.concernId === SCALE.concernId)!;
    expect(d.strength).toBe('none');
    expect(d.evidenceRefs).toEqual([]);
  });

  it('counts coverage over JD-relevant concerns only', () => {
    const cov = detectConcernEvidence([RLS, SCALE], evidence, 'multi-tenant isolation role');
    // RLS relevant + strong; SCALE not JD-relevant (no "scale" token) → excluded from totals
    expect(cov.relevantTotal).toBe(1);
    expect(cov.relevantAddressed).toBe(1);
  });

  it('treats empty JD as all-relevant', () => {
    const cov = detectConcernEvidence([RLS, SCALE], evidence, '');
    expect(cov.relevantTotal).toBe(2);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `yarn workspace @bedrock/shared test src/stage-prep/concern-detection.test.ts`
Expected: FAIL — `detectConcernEvidence` not exported.

- [ ] **Step 3: Implement the detector**

```ts
/** @format */
import type { ProjectEvidenceInput } from './skill-transfer-types.js';
import type {
  SystemDesignConcern, ConcernCoverage, DetectedConcern, ConcernEvidenceRef, ConcernStrength,
} from './system-design-concerns-types.js';

// Local tokenizer — intentionally does NOT strip 'system'/'design' (unlike skill-transfer's),
// since those are meaningful here. Lowercase alphanumeric tokens length >= 3.
function tok(s: string): Set<string> {
  const out = new Set<string>();
  for (const t of s.toLowerCase().split(/[^a-z0-9]+/)) if (t.length >= 3) out.add(t);
  return out;
}
function signalTokens(signals: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const sig of signals) for (const t of tok(sig)) out.add(t);
  return out;
}
function overlaps(sig: Set<string>, label: string): boolean {
  for (const t of tok(label)) if (sig.has(t)) return true;
  return false;
}

type Hit = { ref: ConcernEvidenceRef; tier: 'strong' | 'weak' };

function hitsFor(concern: SystemDesignConcern, ev: ProjectEvidenceInput): Hit[] {
  const sig = signalTokens(concern.detectionSignals);
  if (sig.size === 0) return [];
  const hits: Hit[] = [];
  for (const c of ev.components) if (overlaps(sig, c.name))
    hits.push({ ref: { source: 'component', id: c.id, label: c.name }, tier: 'strong' });
  for (const d of ev.decisions) if (overlaps(sig, d.title) || (d.decision != null && overlaps(sig, d.decision)))
    hits.push({ ref: { source: 'decision', id: d.id, label: d.title }, tier: 'strong' });
  for (const s of ev.stackItems) if (overlaps(sig, s.name))
    hits.push({ ref: { source: 'stack_item', id: s.id, label: s.name }, tier: 'weak' });
  for (const t of ev.tags) if (overlaps(sig, t.tag))
    hits.push({ ref: { source: 'tag', id: `${t.projectId}:${t.tag}`, label: t.tag }, tier: 'weak' });
  for (const e of ev.repoEvidence) if (overlaps(sig, e.rawName))
    hits.push({ ref: { source: e.source, id: e.id, label: e.rawName, fileLine: e.fileLine }, tier: 'weak' });
  return hits;
}

function strengthOf(hits: Hit[]): ConcernStrength {
  if (hits.some(h => h.tier === 'strong')) return 'strong';
  return hits.length > 0 ? 'partial' : 'none';
}

function isRelevant(concern: SystemDesignConcern, jdTokens: Set<string>): boolean {
  if (jdTokens.size === 0) return true;
  return signalTokens(concern.jdSignalKeywords).size === 0
    ? true
    : [...signalTokens(concern.jdSignalKeywords)].some(t => jdTokens.has(t));
}

/**
 * Deterministically detect which concerns the project addresses and how strongly.
 * Pure: evidence refs come only from real project rows, so the result is grounded
 * by construction. `jdText` filters/flags relevance (empty → all relevant).
 */
export function detectConcernEvidence(
  concerns: readonly SystemDesignConcern[],
  evidence: ProjectEvidenceInput,
  jdText: string,
): ConcernCoverage {
  const jdTokens = tok(jdText);
  const detected: DetectedConcern[] = concerns.map((concern) => {
    const hits = hitsFor(concern, evidence);
    return {
      concernId: concern.concernId,
      category: concern.category,
      strength: strengthOf(hits),
      evidenceRefs: hits.map(h => h.ref),
      relevantToJd: isRelevant(concern, jdTokens),
    };
  });
  const relevant = detected.filter(d => d.relevantToJd);
  return {
    detected,
    relevantTotal: relevant.length,
    relevantAddressed: relevant.filter(d => d.strength !== 'none').length,
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `yarn workspace @bedrock/shared test src/stage-prep/concern-detection.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Export + lint**

Add to `applications/shared/src/stage-prep/index.ts`: `export * from './concern-detection.js';`
Run: `npx eslint applications/shared/src/stage-prep/concern-detection.ts`
Expected: no output (complexity of each helper < 10).

- [ ] **Step 6: Commit**

```bash
git add applications/shared/src/stage-prep/concern-detection.ts applications/shared/src/stage-prep/concern-detection.test.ts applications/shared/src/stage-prep/index.ts
git commit -m "feat(shared): deterministic system-design concern detection"
```

---

## Task 5: Walkthrough anti-invention validator (TDD)

**Files:**
- Create: `applications/shared/src/stage-prep/system-design-walkthrough.ts`
- Test: `applications/shared/src/stage-prep/system-design-walkthrough.test.ts`

Contract (mirrors `validateSkillTransfer`): given coach cards + the detected coverage, drop
cards whose `concernId` isn't in the detected set; for a kept card, every `evidenceRef.id` must
be in that concern's detected refs — otherwise demote to an honest gap card
(`choiceMade=null`, `evidenceRefs=[]`, `followUps[].status='gap'`, generic honest `articulation`).

- [ ] **Step 1: Write failing tests**

```ts
/** @format */
import { validateSystemDesignWalkthrough } from './system-design-walkthrough.js';
import type { ConcernCoverage, SystemDesignWalkthroughCard } from './index.js';

const coverage: ConcernCoverage = {
  detected: [
    { concernId: 'rls', category: 'data_isolation', strength: 'strong',
      evidenceRefs: [{ source: 'component', id: 'c1', label: 'RLS layer' }], relevantToJd: true },
    { concernId: 'scale', category: 'scaling', strength: 'none', evidenceRefs: [], relevantToJd: true },
  ],
  relevantTotal: 2, relevantAddressed: 1,
};

const grounded: SystemDesignWalkthroughCard = {
  concernId: 'rls', concernQuestion: 'q', whyItMatters: 'w',
  evidenceRefs: [{ source: 'component', id: 'c1', label: 'RLS layer' }],
  choiceMade: 'Postgres RLS', articulation: 'I chose RLS…',
  followUps: [{ question: 'forgot filter?', status: 'addressed', framing: 'RLS enforces it' }],
  gapGuidance: null,
};

describe('validateSystemDesignWalkthrough', () => {
  it('keeps a fully grounded card unchanged', () => {
    const out = validateSystemDesignWalkthrough([grounded], coverage);
    expect(out).toEqual([grounded]);
  });

  it('drops a card for an unknown concern', () => {
    const ghost = { ...grounded, concernId: 'unknown' };
    expect(validateSystemDesignWalkthrough([ghost], coverage)).toEqual([]);
  });

  it('demotes a card that cites an invented evidence id', () => {
    const invented = { ...grounded, evidenceRefs: [{ source: 'component', id: 'FAKE', label: 'x' }] };
    const [card] = validateSystemDesignWalkthrough([invented], coverage);
    expect(card.choiceMade).toBeNull();
    expect(card.evidenceRefs).toEqual([]);
    expect(card.followUps.every(f => f.status === 'gap')).toBe(true);
  });

  it('passes through an honest gap card for a none-strength concern', () => {
    const gap: SystemDesignWalkthroughCard = {
      concernId: 'scale', concernQuestion: 'q', whyItMatters: 'w', evidenceRefs: [],
      choiceMade: null, articulation: 'No evidence; here is how I would approach it…',
      followUps: [{ question: 'how scale?', status: 'gap', framing: 'honest' }], gapGuidance: 'be honest',
    };
    expect(validateSystemDesignWalkthrough([gap], coverage)).toEqual([gap]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `yarn workspace @bedrock/shared test src/stage-prep/system-design-walkthrough.test.ts`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement the validator**

```ts
/** @format */
import type {
  ConcernCoverage, SystemDesignWalkthroughCard, SystemDesignFollowUp,
} from './system-design-concerns-types.js';

const GAP_ARTICULATION =
  'Your project has no evidence for this concern yet. Be honest: describe how you would ' +
  'approach it and bridge from the nearest real decision you made.';

function toGapCard(card: SystemDesignWalkthroughCard): SystemDesignWalkthroughCard {
  const followUps: SystemDesignFollowUp[] = card.followUps.map(f => ({ ...f, status: 'gap' }));
  return {
    concernId: card.concernId, concernQuestion: card.concernQuestion, whyItMatters: card.whyItMatters,
    evidenceRefs: [], choiceMade: null,
    articulation: card.choiceMade === null ? card.articulation : GAP_ARTICULATION,
    followUps, gapGuidance: card.gapGuidance ?? GAP_ARTICULATION,
  };
}

/**
 * Sanitise coach-emitted walkthrough cards against the deterministic detection.
 * Unknown concern → dropped. Any card citing an evidence id not detected for its
 * concern → demoted to an honest gap. Honest gap cards (no evidence, choiceMade=null)
 * pass through. Anti-invention backstop, mirrors validateSkillTransfer.
 */
export function validateSystemDesignWalkthrough(
  cards: readonly SystemDesignWalkthroughCard[],
  coverage: ConcernCoverage,
): SystemDesignWalkthroughCard[] {
  const refsByConcern = new Map(
    coverage.detected.map(d => [d.concernId, new Set(d.evidenceRefs.map(r => r.id))]),
  );
  const out: SystemDesignWalkthroughCard[] = [];
  for (const card of cards) {
    const allowed = refsByConcern.get(card.concernId);
    if (!allowed) continue; // unknown concern → drop
    if (card.choiceMade === null && card.evidenceRefs.length === 0) { out.push(card); continue; }
    const grounded = card.evidenceRefs.length > 0 && card.evidenceRefs.every(r => allowed.has(r.id));
    out.push(grounded ? card : toGapCard(card));
  }
  return out;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `yarn workspace @bedrock/shared test src/stage-prep/system-design-walkthrough.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Export + lint + commit**

Add to `applications/shared/src/stage-prep/index.ts`: `export * from './system-design-walkthrough.js';`
Run: `npx eslint applications/shared/src/stage-prep/system-design-walkthrough.ts` → no output.

```bash
git add applications/shared/src/stage-prep/system-design-walkthrough.ts applications/shared/src/stage-prep/system-design-walkthrough.test.ts applications/shared/src/stage-prep/index.ts
git commit -m "feat(shared): system-design walkthrough anti-invention validator"
```

---

## Task 6: Coach output — schema, tool, prompt, block

**Files:**
- Modify: `applications/shared/src/strategist-types.ts` (add fields to `InterviewCoachResult`)
- Modify: `applications/job-strategist/src/agents/coach-agent.ts`
- Modify: `applications/job-strategist/src/prompts/coach/stages/system-design.ts`

- [ ] **Step 1: Extend `InterviewCoachResult`**

In `applications/shared/src/strategist-types.ts`, in the `InterviewCoachResult` interface (after
`skillTransfer`), add — importing the types at the top of the file from `./stage-prep/index.js`:

```ts
    /** System-design only: project-anchored walkthrough cards. */
    readonly systemDesignWalkthrough?: readonly SystemDesignWalkthroughCard[];
    /** System-design only: deterministic coverage map + alignment (written by run-coach, not the model). */
    readonly systemDesignCoverage?: ConcernCoverage;
```

Add to the existing import of stage-prep types in that file (find the line importing
`SkillTransferEntry` and add `SystemDesignWalkthroughCard, ConcernCoverage`). Run
`grep -n "SkillTransferEntry" applications/shared/src/strategist-types.ts` to locate it.

- [ ] **Step 2: Add the tool-schema + Zod for the walkthrough field**

In `coach-agent.ts`, inside `COACH_TOOL.inputSchema.properties` (after `compScript`), add:

```ts
            systemDesignWalkthrough: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        concernId:       { type: 'string' },
                        concernQuestion: { type: 'string' },
                        whyItMatters:    { type: 'string' },
                        evidenceRefs: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: { source: { type: 'string' }, id: { type: 'string' }, label: { type: 'string' }, fileLine: { type: 'string' } },
                                required: ['source', 'id', 'label'],
                                additionalProperties: false,
                            },
                        },
                        choiceMade:   { type: ['string', 'null'] },
                        articulation: { type: 'string' },
                        followUps: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    question: { type: 'string' },
                                    status:   { type: 'string', enum: ['addressed', 'partial', 'gap'] },
                                    framing:  { type: 'string' },
                                },
                                required: ['question', 'status', 'framing'],
                                additionalProperties: false,
                            },
                        },
                        gapGuidance: { type: ['string', 'null'] },
                    },
                    required: ['concernId', 'concernQuestion', 'whyItMatters', 'evidenceRefs', 'choiceMade', 'articulation', 'followUps', 'gapGuidance'],
                    additionalProperties: false,
                },
            },
```

In `CoachOutputSchema` (after the `compScript` block, before the closing `}).strict()`), add:

```ts
    systemDesignWalkthrough: z.array(z.object({
        concernId:       z.string(),
        concernQuestion: z.string(),
        whyItMatters:    z.string(),
        evidenceRefs: z.array(z.object({
            source: z.string(), id: z.string(), label: z.string(), fileLine: z.string().optional(),
        }).strict()),
        choiceMade:   z.string().nullable(),
        articulation: z.string(),
        followUps: z.array(z.object({
            question: z.string(),
            status:   z.enum(['addressed', 'partial', 'gap']),
            framing:  z.string(),
        }).strict()),
        gapGuidance: z.string().nullable(),
    }).strict()).optional(),
```

- [ ] **Step 3: Promote the field to required for system-design**

In `coach-agent.ts`, just below `PHONE_SCREEN_FIELDS`, add and update `coachToolForStage`:

```ts
export const SYSTEM_DESIGN_FIELDS = ['systemDesignWalkthrough'] as const;

/** Return the coach tool with stage-specific fields promoted to `required`. */
export function coachToolForStage(stage: string): typeof COACH_TOOL {
    const extra =
        stage === 'phone-screen'  ? PHONE_SCREEN_FIELDS  :
        stage === 'system-design' ? SYSTEM_DESIGN_FIELDS :
        null;
    if (!extra) return COACH_TOOL;
    return {
        ...COACH_TOOL,
        inputSchema: { ...COACH_TOOL.inputSchema, required: [...COACH_TOOL.inputSchema.required, ...extra] },
    };
}
```

(Replace the existing phone-screen-only `coachToolForStage`.)

- [ ] **Step 4: Add the concern-block serialiser**

In `coach-agent.ts`, next to `buildSkillCandidateBlock`, add (imports `ConcernCoverage`,
`SystemDesignConcern` from `@bedrock/shared`):

```ts
/** Render detected concerns + their grounded evidence as a block the model must cite from. */
export function buildConcernWalkthroughBlock(
    coverage: ConcernCoverage,
    concerns: readonly SystemDesignConcern[],
): string {
    const byId = new Map(concerns.map(c => [c.concernId, c]));
    const relevant = coverage.detected.filter(d => d.relevantToJd);
    if (relevant.length === 0) return '';
    const lines = ['## System-design concerns for THIS role (emit one walkthrough card per concern, cite ONLY these evidence ids)'];
    for (const d of relevant) {
        const c = byId.get(d.concernId);
        if (!c) continue;
        lines.push(`- [${d.strength}] ${d.concernId}: ${c.concernQuestion}`);
        lines.push(`    why: ${c.whyInterviewersAsk}`);
        if (d.evidenceRefs.length > 0) {
            for (const r of d.evidenceRefs) lines.push(`    evidence: source=${r.source} id=${r.id} :: ${r.label}${r.fileLine ? ` @${r.fileLine}` : ''}`);
        } else {
            lines.push('    evidence: (none — emit an honest gap card: choiceMade=null, evidenceRefs=[], followUps status="gap")');
        }
        for (const f of c.followUpQuestions) lines.push(`    follow-up: ${f}`);
    }
    lines.push(
        'For EACH concern: cite ONLY the evidence ids listed for it. Write the articulation in ' +
        'first person ("I chose…"), name the trade-off and the failure mode you avoided. For each ' +
        'follow-up set status addressed/partial/gap against the evidence and give honest framing. ' +
        'Never invent evidence or claim scale not shown. No evidence → honest gap card.',
    );
    return lines.join('\n');
}
```

- [ ] **Step 5: Plumb the block into the coach user message**

`buildCoachMessage` already appends `skillCandidateBlock`. Add an optional
`systemDesignBlock` param to `CoachAgentInput` and `buildCoachMessage`, appended the same way
(a `## ...` section). In `executeCoachAgent`, accept and forward it. Concretely:

- Add to `CoachAgentInput`: `readonly systemDesignBlock?: string;`
- In `buildCoachMessage`, after the `skillCandidateBlock` push: `if (systemDesignBlock) sections.push(systemDesignBlock, '');` (thread the param through like `skillCandidateBlock`).
- In `executeCoachAgent` signature add `systemDesignBlock?: string` and pass it into `coachAgent.execute({ ..., systemDesignBlock }, ctx)`.

- [ ] **Step 6: Rewrite the system-design delta**

Replace the body of `applications/job-strategist/src/prompts/coach/stages/system-design.ts`
`SYSTEM_DESIGN_DELTA` with the Socratic-walkthrough instructions:

```ts
/** @format */
/** System-design delta — project-anchored Socratic walkthrough (cards per concern). */
export const SYSTEM_DESIGN_DELTA = [
    `── SYSTEM DESIGN INTERVIEW (project-anchored walkthrough) ─────────`,
    `(interview_stage = "system-design")`,
    `You are rehearsing the candidate through THEIR OWN project, concern by concern, as an`,
    `interviewer would. A "System-design concerns for THIS role" block is provided with the`,
    `concerns to cover and the candidate's detected evidence per concern.`,
    ``,
    `Emit ONE systemDesignWalkthrough card per listed concern:`,
    `• concernId / concernQuestion: copy from the block.`,
    `• whyItMatters: 1-2 sentences tying the concern to THIS role.`,
    `• evidenceRefs: cite ONLY the evidence ids listed for that concern. Invent nothing.`,
    `• choiceMade: the implementation pattern the candidate actually used (null if no evidence).`,
    `• articulation: FIRST PERSON rehearsal script — "I chose X because…", name the trade-off`,
    `  and the failure mode avoided. Sound like an engineer, not a textbook.`,
    `• followUps: for each follow-up in the block, set status addressed/partial/gap against the`,
    `  evidence and give honest framing the candidate can say out loud.`,
    `• gapGuidance: when partial/none, how to handle the gap honestly (never fabricate work).`,
    ``,
    `HONESTY: if a concern has no evidence, emit an honest gap card (choiceMade=null,`,
    `evidenceRefs=[], followUps status="gap"). Never claim scale or work the evidence doesn't show.`,
    `Do NOT emit a skillTransfer array for this stage.`,
].join('\n');
```

- [ ] **Step 7: Typecheck**

Run: `yarn workspace @bedrock/job-strategist typecheck`
Expected: no output. (Fixes flow once run-coach is wired in Task 7 — if `executeCoachAgent`
call sites elsewhere break, that's expected until Task 7; this step may show the run-coach
call-site arity error, which Task 7 resolves.)

- [ ] **Step 8: Commit**

```bash
git add applications/shared/src/strategist-types.ts applications/job-strategist/src/agents/coach-agent.ts applications/job-strategist/src/prompts/coach/stages/system-design.ts
git commit -m "feat(job-strategist): system-design walkthrough coach output schema + prompt"
```

---

## Task 7: Wire detection into run-coach + gate split

**Files:**
- Modify: `applications/job-strategist/src/prompts/coach/stages/index.ts`
- Modify: `applications/job-strategist/src/run-coach.ts`

- [ ] **Step 1: Split the stage gates**

In `prompts/coach/stages/index.ts`, change `stageUsesSkillTransfer` to technical-only and add
a system-design gate:

```ts
/** Project-evidence-anchored SKILL-TRANSFER stages (technical only now). */
export function stageUsesSkillTransfer(stage: InterviewStage): boolean {
    return resolveCoachBranch(stage) === 'technical';
}

/** Project-anchored system-design walkthrough stage. */
export function stageUsesSystemDesignWalkthrough(stage: InterviewStage): boolean {
    return resolveCoachBranch(stage) === 'system-design';
}
```

- [ ] **Step 2: Add a walkthrough builder in run-coach (keep main() simple)**

In `run-coach.ts`, add imports:

```ts
import {
    RdsSystemDesignConcernRepository, detectConcernEvidence, validateSystemDesignWalkthrough,
} from '@bedrock/shared';
import type { ConcernCoverage, SystemDesignConcern, SystemDesignWalkthroughCard } from '@bedrock/shared';
import { buildConcernWalkthroughBlock } from './agents/coach-agent.js';
import { stageUsesSystemDesignWalkthrough } from './prompts/coach/stages/index.js';
```

Add a helper (fail-open, like `buildSkillCandidateSets`):

```ts
interface WalkthroughInputs { block: string; coverage: ConcernCoverage | null; concerns: SystemDesignConcern[]; }

async function buildSystemDesignWalkthroughInputs(
    pool: Pool,
    env: ReturnType<typeof parseCoachEnv>,
    research: StrategistResearchResult | null,
): Promise<WalkthroughInputs> {
    if (!stageUsesSystemDesignWalkthrough(env.interviewStage as InterviewStage)) {
        return { block: '', coverage: null, concerns: [] };
    }
    try {
        const [concerns, evidence] = await Promise.all([
            new RdsSystemDesignConcernRepository(pool).listConcerns(),
            new RdsProjectEvidenceRepository(pool).load(env.userId),
        ]);
        const jdText = `${env.jobDescription} ${(research?.gaps ?? []).map(g => g.skill).join(' ')}`;
        const coverage = detectConcernEvidence(concerns, evidence, jdText);
        return { block: buildConcernWalkthroughBlock(coverage, concerns), coverage, concerns };
    } catch (err) {
        log.warn({ err: String(err) }, 'system-design.walkthrough.detect.failed (non-fatal)');
        return { block: '', coverage: null, concerns: [] };
    }
}
```

- [ ] **Step 3: Call it in main() and validate the output**

In `main()`, after `buildSkillCandidateSets(...)`:

```ts
        const sd = await buildSystemDesignWalkthroughInputs(pool, env, research);
        const coaching = await executeCoachAgent(
            ctx, analysis, constraintBlock, evidenceBlock, skillCandidateSets, sd.block,
        );
        if (sd.coverage) {
            const raw = (coaching.data.systemDesignWalkthrough ?? []) as SystemDesignWalkthroughCard[];
            (coaching.data as { systemDesignWalkthrough?: unknown }).systemDesignWalkthrough =
                validateSystemDesignWalkthrough(raw, sd.coverage);
            (coaching.data as { systemDesignCoverage?: unknown }).systemDesignCoverage = sd.coverage;
        }
```

(Update the existing `executeCoachAgent` call to pass `sd.block` as the new 6th arg. The
grounding call right after stays unchanged.)

- [ ] **Step 4: Typecheck + lint**

Run: `yarn workspace @bedrock/job-strategist typecheck`
Expected: no output.
Run: `npx eslint applications/job-strategist/src/run-coach.ts applications/job-strategist/src/prompts/coach/stages/index.ts`
Expected: no output. (If `main` exceeds complexity 10, the new logic is already factored into
`buildSystemDesignWalkthroughInputs`; keep the in-`main` block to the ~6 lines above.)

- [ ] **Step 5: Commit**

```bash
git add applications/job-strategist/src/run-coach.ts applications/job-strategist/src/prompts/coach/stages/index.ts
git commit -m "feat(job-strategist): wire deterministic concern detection into run-coach"
```

---

## Task 8: Evals — grader, fixture, stage-focus update

**Files:**
- Create: `applications/job-strategist/src/evals/graders/system-design-grader.ts`
- Test: `applications/job-strategist/src/evals/graders/system-design-grader.test.ts`
- Modify: `applications/job-strategist/src/evals/graders/stage-focus-grader.ts` (+ `.test.ts`)
- Modify: `applications/job-strategist/src/evals/fixtures/system-design.json`
- Modify: `applications/job-strategist/src/evals/coach-evals.test.ts`

- [ ] **Step 1: Move system-design out of the skillTransfer branch in stage-focus-grader**

In `stage-focus-grader.ts`, remove `'system-design'` from `PROJECT_ANCHORED` and add a branch
that checks walkthrough presence:

```ts
const PROJECT_ANCHORED = new Set(['technical-1', 'technical-2']);

function systemDesignFailures(o: InterviewCoachResult): string[] {
    const cards = o.systemDesignWalkthrough;
    return cards && cards.length > 0 ? [] : ['system-design: empty systemDesignWalkthrough'];
}
```

And in the dispatcher add `else if (s === 'system-design') failures = systemDesignFailures(output);`
before the behavioural branch. Update `stage-focus-grader.test.ts`: replace the two
`system-design` skillTransfer cases with one passing case (a card present) and one failing case
(empty walkthrough).

- [ ] **Step 2: Write the walkthrough grader (failing test first)**

Test `system-design-grader.test.ts`:

```ts
/** @format */
import { systemDesignGrader } from './system-design-grader.js';
import type { EvalInput } from '../graders.js';
import type { InterviewCoachResult } from '@bedrock/shared';

const baseInput = (): EvalInput => ({ analysisXml: '<x/>', candidateSets: [], stage: 'system-design' });

const coverage = {
    detected: [{ concernId: 'rls', category: 'data_isolation', strength: 'strong',
        evidenceRefs: [{ source: 'component', id: 'c1', label: 'RLS' }], relevantToJd: true }],
    relevantTotal: 1, relevantAddressed: 1,
};

function out(cards: unknown): InterviewCoachResult {
    return { stage: 'system-design', systemDesignWalkthrough: cards, systemDesignCoverage: coverage } as unknown as InterviewCoachResult;
}

describe('systemDesignGrader', () => {
    it('passes a grounded card that covers the relevant concern', () => {
        const r = systemDesignGrader(baseInput(), out([{ concernId: 'rls', concernQuestion: 'q', whyItMatters: 'w',
            evidenceRefs: [{ source: 'component', id: 'c1', label: 'RLS' }], choiceMade: 'RLS', articulation: 'I…',
            followUps: [], gapGuidance: null }]));
        expect(r.pass).toBe(true);
    });
    it('fails when a card cites an evidence id not in the detected set', () => {
        const r = systemDesignGrader(baseInput(), out([{ concernId: 'rls', concernQuestion: 'q', whyItMatters: 'w',
            evidenceRefs: [{ source: 'component', id: 'FAKE', label: 'x' }], choiceMade: 'RLS', articulation: 'I…',
            followUps: [], gapGuidance: null }]));
        expect(r.pass).toBe(false);
    });
    it('fails when a JD-relevant concern has no card', () => {
        const r = systemDesignGrader(baseInput(), out([]));
        expect(r.pass).toBe(false);
    });
});
```

Run: `yarn workspace @bedrock/job-strategist test src/evals/graders/system-design-grader.test.ts`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement the grader**

```ts
/** @format */
import { mkResult } from '../graders.js';
import type { Grader } from '../graders.js';
import type { ConcernCoverage, SystemDesignWalkthroughCard } from '@bedrock/shared';

/** Every JD-relevant concern must have a card. */
function coverageFailures(coverage: ConcernCoverage, cards: readonly SystemDesignWalkthroughCard[]): string[] {
    const covered = new Set(cards.map(c => c.concernId));
    return coverage.detected
        .filter(d => d.relevantToJd && !covered.has(d.concernId))
        .map(d => `no card for relevant concern: ${d.concernId}`);
}

/** A single card: known concern, no invented evidence ids, gap cards carry no evidence. */
function cardFailures(card: SystemDesignWalkthroughCard, allowed: Set<string> | undefined): string[] {
    if (!allowed) return [`card for unknown concern: ${card.concernId}`];
    const f = card.evidenceRefs.filter(r => !allowed.has(r.id)).map(r => `invented evidence id "${r.id}" for ${card.concernId}`);
    if (card.choiceMade === null && card.evidenceRefs.length > 0) f.push(`gap card "${card.concernId}" must have no evidenceRefs`);
    return f;
}

/**
 * Grounding + coverage + honesty for system-design walkthroughs. Every cited evidence id must
 * exist in the deterministic coverage; every JD-relevant concern must have a card; gap cards
 * (choiceMade=null) must carry no evidence.
 */
export const systemDesignGrader: Grader = (input, output) => {
    if (input.stage !== 'system-design') return mkResult('system-design', []);
    const coverage = (output as { systemDesignCoverage?: ConcernCoverage }).systemDesignCoverage;
    const cards = (output as { systemDesignWalkthrough?: SystemDesignWalkthroughCard[] }).systemDesignWalkthrough ?? [];
    if (!coverage) return mkResult('system-design', ['missing systemDesignCoverage']);

    const refsByConcern = new Map(coverage.detected.map(d => [d.concernId, new Set(d.evidenceRefs.map(r => r.id))]));
    const failures = [
        ...coverageFailures(coverage, cards),
        ...cards.flatMap(card => cardFailures(card, refsByConcern.get(card.concernId))),
    ];
    return mkResult('system-design', failures);
};
```

Run: `yarn workspace @bedrock/job-strategist test src/evals/graders/system-design-grader.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 4: Replace the system-design gold fixture**

Overwrite `applications/job-strategist/src/evals/fixtures/system-design.json` so `input.stage`
is `system-design`, `input.candidateSets` is `[]`, and `output` carries a grounded
`systemDesignCoverage` + matching `systemDesignWalkthrough` (one strong card + one honest gap
card), and **no** `skillTransfer`. Shape mirrors the grader test's `coverage`/cards. Ensure every
`evidenceRefs[].id` in a card appears in the matching `systemDesignCoverage.detected[].evidenceRefs`.

- [ ] **Step 5: Register the grader in the Tier-1 suite**

In `coach-evals.test.ts`, import `systemDesignGrader` and add it to the `GRADERS` array.

- [ ] **Step 6: Run the full eval suite**

Run: `yarn workspace @bedrock/job-strategist test src/evals`
Expected: PASS — all fixtures (incl. system-design) green across every grader.

- [ ] **Step 7: Full suite + lint + typecheck**

Run: `yarn workspace @bedrock/job-strategist test` → all pass.
Run: `yarn workspace @bedrock/shared test` → all pass.
Run: `yarn workspace @bedrock/job-strategist typecheck` → no output.
Run: `npx eslint applications/job-strategist/src/evals/graders/system-design-grader.ts applications/job-strategist/src/evals/graders/stage-focus-grader.ts` → no output.

- [ ] **Step 8: Commit**

```bash
git add applications/job-strategist/src/evals/
git commit -m "test(job-strategist): system-design walkthrough grader + gold fixture"
```

---

## Final verification

- [ ] `yarn workspace @bedrock/shared test` — all pass.
- [ ] `yarn workspace @bedrock/job-strategist test` — all pass (incl. system-design fixture across all graders).
- [ ] `yarn workspace @bedrock/job-strategist typecheck` && `yarn workspace @bedrock/shared typecheck` — clean.
- [ ] `npx eslint <all files touched by this plan>` — zero errors (`complexity:10` respected).
- [ ] Manual dogfood check (optional, needs dev DB): run the coach for a `system-design` stage against your own ai-applications project; confirm the walkthrough cites real file:line evidence (RLS, rate-limiting, self-healing) and that absent concerns render as honest gap cards.

## Notes for the implementer

- **Grounding is layered:** detection is grounded by construction (refs come from real rows); `validateSystemDesignWalkthrough` is the deterministic backstop; `verifyCoachGrounding` (already wired, all stages) covers free-text prose. Don't add a second LLM verification pass.
- **`systemDesignCoverage` is authoritative** and written by `run-coach`, never trusted from the model — the grader reads it as ground truth.
- **Fail-open everywhere:** ontology/detection errors fall back to empty walkthrough + generic coaching; never fail the run.
- **Out of scope (do not build):** practice mode, transcript analysis, embedding JD-relevance, UI/serve endpoint (tucaken-app), expanding the ontology past the v1 ~14.
