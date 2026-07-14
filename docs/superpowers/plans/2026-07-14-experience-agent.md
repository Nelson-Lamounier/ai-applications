# Phase 4 -- Dedicated Experience Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decouple resume Experience generation into a dedicated Sonnet agent that rewrites/reorders the user's indexed career lines against the JD with schema-enforced provenance, a full ATS mirror lane (targets -> strict coverage -> one bounded re-write), Phase-3-grade observability, and evals.

**Architecture:** The strategist-writer emits experience as a roster skeleton (`highlights: []`); a new `fillResumeExperience` splice (before `fillResumeSummary`) runs `executeExperienceAgent` (forced `emit_experience` tool, thinkingBudget 0), validates provenance deterministically, scores coverage with the REUSED strict `scoreSummaryCoverage`, fires at most one re-write under `strategist-experience-rewrite`, and the SYSTEM assembles the final strings. Fallback = career highlights verbatim. Metric weave is scoped to skip experience; the rest of the downstream chain stays as a counted safety net.

**Tech Stack:** TypeScript (ESM, `.js` specifiers), ts-jest, Zod, prom-client, AWS Bedrock (`runAgent`), pino->Alloy->Loki.

## Global Constraints

- Branch `feat/experience-agent` (exists, off develop, spec committed d3c079ba). Base facts verified 2026-07-14.
- Run root `yarn eslint <changed .ts files>` (no workspace eslint binary); `yarn workspace @bedrock/job-strategist exec tsc --noEmit` (+ shared when touched); full suite green per task.
- ASCII ONLY in every added line (use `--`, `->`, straight quotes). English (UK). No `Co-Authored-By` trailer. NEVER `git stash`.
- Prompt edits: bump frontmatter `version` AND update `prompt-manifest.json` sha256 (the integrity test prints the new hash on failure). No prompt change ships without its eval (Task 9).
- Sonnet for the experience agent (`STRATEGIST_MODEL` default `eu.anthropic.claude-sonnet-4-6`); forced tool + `thinkingBudget: 0` (constrained decoding -- the 2026-07-08 "metrics tripled thinking" measurement applied to the extended-thinking writer, not forced-tool calls).
- Truthfulness invariants (spec "Decisions"): targets verified/transferable only; every bullet cites source lines; every career line accounted for; roster byte-identical; re-write throw/invalid keeps first; first-pass invalid/error -> career highlights VERBATIM.
- Complexity:10 not CI-enforced but introduce NO new violations -- extract helpers.
- Test placement: `ats/` tests in `ats/<sub>/__tests__/`; `agents/writer` tests in `agents/writer/__tests__/`.
- `SummaryAtsTarget = {skill; source: 'disqualifying'|'hard'|'soft'; verdict: 'verified'|'transferable'}` (`ats/gate/summary-ats-targets.ts`); `scoreSummaryCoverage(summary: string, targets: readonly SummaryAtsTarget[]): {targets; covered; missing[]}` strict adjacent-phrase (`ats/gate/summary-coverage.ts`) -- REUSE, never reimplement, never swap for matchTier1.
- `CareerEntry = {title; company; period; highlights: string[]}` (`agents/evidence/career-history.ts:4-9`).
- `JobRequirement = {skill: string; context: string; disqualifying?: boolean}`; `JdSignal.hardRequirements: JobRequirement[]` (`shared/src/strategist-types.ts:378,468`).

---

### Task 1: `selectExperienceAtsTargets` -- top-6 attainable targets with requirement grouping

**Files:**
- Create: `applications/job-strategist/src/ats/gate/experience-ats-targets.ts`
- Test: `applications/job-strategist/src/ats/gate/__tests__/experience-ats-targets.test.ts`

**Interfaces:**
- Consumes: `SkillEvidenceEntry` (`@bedrock/shared`), `matchTier1` (`../matching/keyword-match.js`), `SummaryAtsTarget` type (`./summary-ats-targets.js`).
- Produces: `interface ExperienceAtsTarget extends SummaryAtsTarget { readonly requirement: string }` and `selectExperienceAtsTargets(ledger, jd, limit = 6): ExperienceAtsTarget[]`. (`ExperienceAtsTarget[]` is assignable to `readonly SummaryAtsTarget[]` -- Task 6 relies on that for scoring.)

- [ ] **Step 1: Write the failing test**

```typescript
/** @format */
import { describe, it, expect } from '@jest/globals';
import { selectExperienceAtsTargets } from '../experience-ats-targets.js';

const entry = (tool: string, status: string) =>
  ({ tool, status, evidenceFiles: [], evidence: '', transferableBridge: '' });
const ledger = [
  entry('DNS', 'verified'), entry('TCP/IP', 'verified'), entry('SSL/TLS', 'transferable'),
  entry('Kubernetes', 'verified'), entry('Go', 'gap'), entry('AWS', 'verified'),
  entry('Terraform', 'transferable'), entry('Python', 'verified'),
] as never;
const NETWORKING = 'Networking concepts and protocols (DNS, TCP/IP, SSL/TLS, etc)';
const jd = { hardRequirements: [
  { skill: NETWORKING, context: '', disqualifying: true },
  { skill: 'Kubernetes', context: '' },
  { skill: 'Go', context: '', disqualifying: true },
  { skill: 'AWS', context: '' },
  { skill: 'Terraform', context: '' },
  { skill: 'Python', context: '' },
] };

describe('selectExperienceAtsTargets', () => {
  it('matches composite requirements member-by-member and stamps the requirement text', () => {
    const t = selectExperienceAtsTargets(ledger, jd, 6);
    const net = t.filter((x) => x.requirement === NETWORKING).map((x) => x.skill);
    expect(net).toEqual(expect.arrayContaining(['DNS', 'TCP/IP', 'SSL/TLS']));
    expect(t.find((x) => x.skill === 'Go')).toBeUndefined(); // gap excluded
  });
  it('orders disqualifying first, verified before transferable, caps at limit', () => {
    const t = selectExperienceAtsTargets(ledger, jd, 6);
    expect(t).toHaveLength(6);
    expect(t[0]?.source).toBe('disqualifying');
    const first = t.findIndex((x) => x.verdict === 'transferable');
    const lastVerifiedSameSource = t.filter((x) => x.source === t[Math.max(first, 0)]?.source && x.verdict === 'verified');
    expect(first === -1 || lastVerifiedSameSource.every((x) => t.indexOf(x) < first || t[first] === undefined || t[first].source !== x.source)).toBe(true);
  });
  it('returns [] when nothing attainable matches', () => {
    expect(selectExperienceAtsTargets([entry('Rust', 'gap')] as never, jd, 6)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run -- FAIL** (`yarn workspace @bedrock/job-strategist test -- experience-ats-targets`), module not found.
- [ ] **Step 3: Implement**

```typescript
/** @format */
import type { SkillEvidenceEntry } from '@bedrock/shared';
import { matchTier1 } from '../matching/keyword-match.js';
import type { SummaryAtsTarget } from './summary-ats-targets.js';

export interface ExperienceAtsTarget extends SummaryAtsTarget {
  /** The JD requirement this target belongs to -- lets the message group a
   *  composite requirement ("Networking ... (DNS, TCP/IP, SSL/TLS)") with its
   *  attainable members. */
  readonly requirement: string;
}

interface JdLike {
  readonly hardRequirements: ReadonlyArray<{ skill: string; disqualifying?: boolean }>;
}

/** Top-N attainable (verified/transferable, never gap) JD must-have targets for
 *  the experience section, requirement-stamped. Same matching semantics as
 *  selectSummaryAtsTargets (bidirectional matchTier1 + exact lowercase), wider
 *  limit, and the ledger-tool side is the emitted skill so composite JD
 *  requirements contribute each attainable member. */
export function selectExperienceAtsTargets(
  ledger: readonly SkillEvidenceEntry[],
  jd: JdLike,
  limit = 6,
): ExperienceAtsTarget[] {
  const attainable = ledger.filter((e) => e.status === 'verified' || e.status === 'transferable');
  const targets: ExperienceAtsTarget[] = [];
  for (const e of attainable) {
    const req = jd.hardRequirements.find(
      (r) =>
        matchTier1(r.skill, e.tool.toLowerCase()) ||
        matchTier1(e.tool, r.skill.toLowerCase()) ||
        r.skill.toLowerCase() === e.tool.toLowerCase(),
    );
    if (!req) continue;
    targets.push({
      skill: e.tool,
      source: req.disqualifying ? 'disqualifying' : 'hard',
      verdict: e.status as 'verified' | 'transferable',
      requirement: req.skill,
    });
  }
  const rank = { disqualifying: 0, hard: 1, soft: 2 } as const;
  targets.sort(
    (a, b) =>
      rank[a.source] - rank[b.source] ||
      (a.verdict === 'verified' ? 0 : 1) - (b.verdict === 'verified' ? 0 : 1),
  );
  return targets.slice(0, limit);
}
```

- [ ] **Step 4: Run -- PASS.** If ordering assertions fail, fix the sort only.
- [ ] **Step 5: Lint + tsc + commit**

```bash
yarn eslint applications/job-strategist/src/ats/gate/experience-ats-targets.ts applications/job-strategist/src/ats/gate/__tests__/experience-ats-targets.test.ts
yarn workspace @bedrock/job-strategist exec tsc --noEmit
git add applications/job-strategist/src/ats/gate/experience-ats-targets.ts applications/job-strategist/src/ats/gate/__tests__/experience-ats-targets.test.ts
git commit -m "feat(ats): selectExperienceAtsTargets -- top-6 attainable targets with requirement grouping"
```

### Task 2: experience schema + provenance validator + system assembly

**Files:**
- Create: `applications/job-strategist/src/agents/writer/experience-schema.ts`
- Create: `applications/job-strategist/src/agents/writer/experience-provenance.ts`
- Test: `applications/job-strategist/src/agents/writer/__tests__/experience-provenance.test.ts`

**Interfaces:**
- Produces (schema): `ExperienceAgentBullet {text; sources: string[]; atsTargets: string[]}`, `ExperienceAgentRole {company; title; period; highlights: ExperienceAgentBullet[]}`, `ExperienceAgentOutput {roles; accounting: {dropped: {line; reason}[]}}`, Zod `ExperienceAgentOutputSchema`, JSON `EXPERIENCE_EMIT_INPUT_SCHEMA`.
- Produces (provenance): `IndexedCareerLine {id; roleIndex; text}`, `indexCareerLines(entries): IndexedCareerLine[]` (ids `c{i}.h{j}`), `rosterFromCareer(entries): {company;title;period}[]`, `validateExperienceProvenance(out, roster, lines): string[]`, `assembleExperience(out): {company;title;period;highlights: string[]}[]`.

- [ ] **Step 1: Write the failing test**

```typescript
/** @format */
import { describe, it, expect } from '@jest/globals';
import {
  indexCareerLines, rosterFromCareer, validateExperienceProvenance, assembleExperience,
} from '../experience-provenance.js';
import type { ExperienceAgentOutput } from '../experience-schema.js';

const entries = [
  { title: 'Support Engineer', company: 'AWS', period: '2023-2025',
    highlights: ['Configured VPC networking and Route53 DNS', 'Resolved Sev-2 escalations'] },
  { title: 'QA Analyst', company: 'Acme', period: '2021-2023', highlights: ['Automated regression suites'] },
];
const lines = indexCareerLines(entries as never);
const roster = rosterFromCareer(entries as never);

const good: ExperienceAgentOutput = {
  roles: [
    { company: 'AWS', title: 'Support Engineer', period: '2023-2025',
      highlights: [
        { text: 'Applied networking protocols (DNS, TCP/IP) hardening VPC connectivity', sources: ['c0.h0'], atsTargets: ['DNS', 'TCP/IP'] },
        { text: 'Resolved Sev-2 escalations with customer security teams', sources: ['c0.h1'], atsTargets: [] },
      ] },
    { company: 'Acme', title: 'QA Analyst', period: '2021-2023',
      highlights: [{ text: 'Automated regression suites gating releases', sources: ['c1.h0'], atsTargets: [] }] },
  ],
  accounting: { dropped: [] },
};

describe('experience provenance', () => {
  it('indexes lines as c{i}.h{j} and builds the roster', () => {
    expect(lines.map((l) => l.id)).toEqual(['c0.h0', 'c0.h1', 'c1.h0']);
    expect(roster[0]).toEqual({ company: 'AWS', title: 'Support Engineer', period: '2023-2025' });
  });
  it('accepts a fully-cited, fully-accounted output', () => {
    expect(validateExperienceProvenance(good, roster, lines)).toEqual([]);
  });
  it('rejects a bullet citing another employer\'s line', () => {
    const bad = structuredClone(good);
    bad.roles[1]!.highlights[0]!.sources = ['c0.h0'];
    expect(validateExperienceProvenance(bad, roster, lines)).toContain('cross_role_citation:Acme:c0.h0');
  });
  it('rejects when a career line is neither used nor dropped', () => {
    const bad = structuredClone(good);
    bad.roles[0]!.highlights = [bad.roles[0]!.highlights[0]!];
    expect(validateExperienceProvenance(bad, roster, lines)).toContain('unaccounted_line:c0.h1');
  });
  it('rejects roster drift (renamed title)', () => {
    const bad = structuredClone(good);
    bad.roles[0]!.title = 'Senior Support Engineer';
    expect(validateExperienceProvenance(bad, roster, lines)).toContain('roster_drift:0');
  });
  it('rejects an uncited bullet and enforces max 5 bullets', () => {
    const bad = structuredClone(good);
    bad.roles[0]!.highlights[0]!.sources = [];
    expect(validateExperienceProvenance(bad, roster, lines)).toContain('uncited_bullet:AWS:0');
    const six = structuredClone(good);
    six.roles[0]!.highlights = Array.from({ length: 6 }, () => ({ text: 'x', sources: ['c0.h0'], atsTargets: [] }));
    six.accounting.dropped = [{ line: 'c0.h1', reason: 'redundant' }];
    expect(validateExperienceProvenance(six, roster, lines)).toContain('bullet_count:AWS:6');
  });
  it('assembles plain-string highlights preserving order', () => {
    expect(assembleExperience(good)[0]).toEqual({
      company: 'AWS', title: 'Support Engineer', period: '2023-2025',
      highlights: [
        'Applied networking protocols (DNS, TCP/IP) hardening VPC connectivity',
        'Resolved Sev-2 escalations with customer security teams',
      ],
    });
  });
});
```

- [ ] **Step 2: Run -- FAIL.**
- [ ] **Step 3: Implement `experience-schema.ts`**

```typescript
/** @format */
import { z } from 'zod';

export const ExperienceAgentBulletSchema = z.object({
  text: z.string().min(1),
  sources: z.array(z.string()),
  atsTargets: z.array(z.string()).catch([]),
});
export const ExperienceAgentRoleSchema = z.object({
  company: z.string(),
  title: z.string(),
  period: z.string(),
  highlights: z.array(ExperienceAgentBulletSchema),
});
export const ExperienceAgentOutputSchema = z.object({
  roles: z.array(ExperienceAgentRoleSchema),
  accounting: z.object({
    dropped: z.array(z.object({ line: z.string(), reason: z.string() })).catch([]),
  }).catch({ dropped: [] }),
});
export type ExperienceAgentBullet = z.infer<typeof ExperienceAgentBulletSchema>;
export type ExperienceAgentRole = z.infer<typeof ExperienceAgentRoleSchema>;
export type ExperienceAgentOutput = z.infer<typeof ExperienceAgentOutputSchema>;

/** Forced-tool input schema (constrained decoding) for emit_experience. */
export const EXPERIENCE_EMIT_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    roles: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          company: { type: 'string' }, title: { type: 'string' }, period: { type: 'string' },
          highlights: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                text: { type: 'string' },
                sources: { type: 'array', items: { type: 'string' } },
                atsTargets: { type: 'array', items: { type: 'string' } },
              },
              required: ['text', 'sources'],
            },
          },
        },
        required: ['company', 'title', 'period', 'highlights'],
      },
    },
    accounting: {
      type: 'object',
      properties: {
        dropped: {
          type: 'array',
          items: {
            type: 'object',
            properties: { line: { type: 'string' }, reason: { type: 'string' } },
            required: ['line', 'reason'],
          },
        },
      },
      required: ['dropped'],
    },
  },
  required: ['roles', 'accounting'],
} as const;
```

- [ ] **Step 4: Implement `experience-provenance.ts`**

```typescript
/** @format */
import type { CareerEntry } from '../evidence/career-history.js';
import type { ExperienceAgentOutput } from './experience-schema.js';

export interface IndexedCareerLine {
  readonly id: string;        // c{roleIndex}.h{lineIndex}
  readonly roleIndex: number;
  readonly text: string;
}
export interface RosterEntry { readonly company: string; readonly title: string; readonly period: string; }

export function indexCareerLines(entries: readonly CareerEntry[]): IndexedCareerLine[] {
  return entries.flatMap((e, i) => e.highlights.map((text, j) => ({ id: `c${i}.h${j}`, roleIndex: i, text })));
}

export function rosterFromCareer(entries: readonly CareerEntry[]): RosterEntry[] {
  return entries.map((e) => ({ company: e.company, title: e.title, period: e.period }));
}

const MAX_BULLETS = 5;

/**
 * Deterministic provenance rules (spec section experience-provenance):
 * (a) every bullet cites >=1 career line OF ITS OWN role (metric ids `m*` are
 *     secondary -- they never satisfy the requirement alone);
 * (b) every input career line appears in some bullet's sources or in
 *     accounting.dropped;
 * (c) company/title/period byte-identical to the roster, same order and count;
 * (d) 1..5 bullets per role with >=1 career line; min 2 when the role has >=2
 *     lines; roles with 0 lines may have 0 bullets.
 * Returns machine-readable violation tokens; empty array = valid.
 */
export function validateExperienceProvenance(
  out: ExperienceAgentOutput,
  roster: readonly RosterEntry[],
  lines: readonly IndexedCareerLine[],
): string[] {
  const violations: string[] = [];
  const lineById = new Map(lines.map((l) => [l.id, l]));
  if (out.roles.length !== roster.length) violations.push(`roster_count:${out.roles.length}`);

  const cited = new Set<string>();
  out.roles.forEach((role, i) => {
    const r = roster[i];
    if (r && (role.company !== r.company || role.title !== r.title || role.period !== r.period)) {
      violations.push(`roster_drift:${i}`);
    }
    const roleLineCount = lines.filter((l) => l.roleIndex === i).length;
    const min = Math.min(2, roleLineCount);
    if (role.highlights.length > MAX_BULLETS || role.highlights.length < min) {
      violations.push(`bullet_count:${role.company}:${role.highlights.length}`);
    }
    role.highlights.forEach((b, bi) => {
      const careerSources = b.sources.filter((s) => lineById.has(s));
      if (careerSources.length === 0) violations.push(`uncited_bullet:${role.company}:${bi}`);
      for (const s of careerSources) {
        cited.add(s);
        if (lineById.get(s)!.roleIndex !== i) violations.push(`cross_role_citation:${role.company}:${s}`);
      }
    });
  });

  const dropped = new Set(out.accounting.dropped.map((d) => d.line));
  for (const l of lines) {
    if (!cited.has(l.id) && !dropped.has(l.id)) violations.push(`unaccounted_line:${l.id}`);
  }
  return violations;
}

/** The SYSTEM assembles the final section -- the model never emits final strings unchecked. */
export function assembleExperience(
  out: ExperienceAgentOutput,
): Array<{ company: string; title: string; period: string; highlights: string[] }> {
  return out.roles.map((r) => ({
    company: r.company, title: r.title, period: r.period,
    highlights: r.highlights.map((b) => b.text),
  }));
}
```

NOTE: if `CareerEntry` is not exported from `career-history.ts`, export it there (type-only, additive) in this task and mention it in the report.

- [ ] **Step 5: Run -- PASS; lint both files + test; tsc; commit**

```bash
git add applications/job-strategist/src/agents/writer/experience-schema.ts applications/job-strategist/src/agents/writer/experience-provenance.ts applications/job-strategist/src/agents/writer/__tests__/experience-provenance.test.ts
git commit -m "feat(job-strategist): experience agent schema + deterministic provenance validation"
```
(Include `career-history.ts` in the add ONLY if the export was needed.)

### Task 3: `experience-message.ts` -- indexed career lines + targets + metrics payload

**Files:**
- Create: `applications/job-strategist/src/agents/writer/experience-message.ts`
- Test: `applications/job-strategist/src/agents/writer/__tests__/experience-message.test.ts`

**Interfaces:**
- Consumes: `IndexedCareerLine`, `RosterEntry` (Task 2), `ExperienceAtsTarget` (Task 1), `StrategistResearchResult` (`@bedrock/shared`).
- Produces:

```typescript
export interface ExperienceMessageInput {
  readonly research: StrategistResearchResult;
  readonly roster: readonly RosterEntry[];
  readonly careerLines: readonly IndexedCareerLine[];
  readonly atsTargets: readonly ExperienceAtsTarget[];
  readonly groundedMetrics: string;   // composeMetricsBlock output ('' when none)
  readonly codeStack: string;         // codeStackContext block ('' when none)
  readonly rewriteDraft?: string;
  readonly rewriteMissing?: readonly string[];
}
export function buildExperienceMessage(m: ExperienceMessageInput): string;
```

- [ ] **Step 1: Failing test**

```typescript
/** @format */
import { describe, it, expect } from '@jest/globals';
import { buildExperienceMessage } from '../experience-message.js';

const research = {
  targetRole: 'Technical Services Engineer', targetCompany: 'MongoDB', fitSummary: 'Solid fit.',
  verifiedMatches: [{ skill: 'DNS', evidence: 'Route53 zones in infra/', sourceCitation: 'infra/dns.ts', recency: 'current' }],
  partialMatches: [], gaps: [],
} as never;
const base = {
  research,
  roster: [{ company: 'AWS', title: 'Support Engineer', period: '2023-2025' }],
  careerLines: [{ id: 'c0.h0', roleIndex: 0, text: 'Configured VPC networking and Route53 DNS' }],
  atsTargets: [{ skill: 'DNS', source: 'disqualifying' as const, verdict: 'verified' as const, requirement: 'Networking concepts and protocols (DNS, TCP/IP, SSL/TLS)' }],
  groundedMetrics: '- cut MTTR by 30% (runbooks/incident.md)',
  codeStack: 'Current: EKS, Terraform',
};

describe('buildExperienceMessage', () => {
  it('emits indexed career lines under the accounting contract', () => {
    const msg = buildExperienceMessage(base);
    expect(msg).toContain('[c0.h0] Configured VPC networking and Route53 DNS');
    expect(msg).toContain('## Career History');
    expect(msg).toContain('accounted for');
  });
  it('groups ATS targets under their JD requirement', () => {
    const msg = buildExperienceMessage(base);
    expect(msg).toContain('Networking concepts and protocols (DNS, TCP/IP, SSL/TLS)');
    expect(msg).toContain('- DNS (verified)');
  });
  it('includes metrics and code stack; omits empty sections', () => {
    const msg = buildExperienceMessage(base);
    expect(msg).toContain('## Grounded Metrics');
    expect(msg).toContain('cut MTTR by 30%');
    const bare = buildExperienceMessage({ ...base, groundedMetrics: '', codeStack: '', atsTargets: [] });
    expect(bare).not.toContain('## Grounded Metrics');
    expect(bare).not.toContain('## ATS Targets');
  });
  it('adds the re-write block only on the re-write pass', () => {
    expect(buildExperienceMessage(base)).not.toContain('## Re-write pass');
    const rw = buildExperienceMessage({ ...base, rewriteDraft: 'AWS | Support Engineer\n- old bullet', rewriteMissing: ['TCP/IP'] });
    expect(rw).toContain('## Re-write pass');
    expect(rw).toContain('TCP/IP');
  });
});
```

- [ ] **Step 2: Run -- FAIL.**
- [ ] **Step 3: Implement**

```typescript
/** @format */
import type { StrategistResearchResult } from '@bedrock/shared';
import type { ExperienceAtsTarget } from '../../ats/gate/experience-ats-targets.js';
import type { IndexedCareerLine, RosterEntry } from './experience-provenance.js';

export interface ExperienceMessageInput {
  readonly research: StrategistResearchResult;
  readonly roster: readonly RosterEntry[];
  readonly careerLines: readonly IndexedCareerLine[];
  readonly atsTargets: readonly ExperienceAtsTarget[];
  readonly groundedMetrics: string;
  readonly codeStack: string;
  readonly rewriteDraft?: string;
  readonly rewriteMissing?: readonly string[];
}

function careerSection(roster: readonly RosterEntry[], lines: readonly IndexedCareerLine[]): string[] {
  const out = ['## Career History (line-by-line, indexed -- every line MUST be accounted for)',
    'Rewrite, merge, or reorder these lines against the JD; drop a line ONLY with a reason in accounting.dropped.',
    'Never copy verbatim when JD vocabulary honestly applies; never write a bullet no line supports.'];
  roster.forEach((r, i) => {
    out.push('', `### ${r.title} -- ${r.company} (${r.period})`);
    for (const l of lines.filter((x) => x.roleIndex === i)) out.push(`[${l.id}] ${l.text}`);
  });
  return out;
}

function targetsSection(targets: readonly ExperienceAtsTarget[]): string[] {
  if (targets.length === 0) return [];
  const byReq = new Map<string, ExperienceAtsTarget[]>();
  for (const t of targets) byReq.set(t.requirement, [...(byReq.get(t.requirement) ?? []), t]);
  const out = ['', '## ATS Targets (weave each into a bullet ONLY where a cited line honestly supports it)'];
  for (const [req, ts] of byReq) {
    out.push(`Requirement: ${req}`);
    for (const t of ts) out.push(`- ${t.skill} (${t.verdict})`);
  }
  return out;
}

function evidenceSections(m: ExperienceMessageInput): string[] {
  const out: string[] = ['', '## Verified Matches (evidence for rewrites -- cite honestly)'];
  for (const v of m.research.verifiedMatches) out.push(`- ${v.skill}: ${v.evidence} [${v.sourceCitation}]`);
  if (m.groundedMetrics.trim()) out.push('', '## Grounded Metrics (the ONLY permitted numbers -- verbatim or not at all)', m.groundedMetrics);
  if (m.codeStack.trim()) out.push('', '## Code Stack (present current technology as current)', m.codeStack);
  return out;
}

function rewriteSection(m: ExperienceMessageInput): string[] {
  if (!m.rewriteDraft || (m.rewriteMissing?.length ?? 0) === 0) return [];
  return ['', '## Re-write pass (keep the narrative; weave the missing targets only if honestly supported)',
    'Previous draft:', m.rewriteDraft,
    'Missing targets to weave if a cited line supports them:',
    ...(m.rewriteMissing ?? []).map((t) => `- ${t}`)];
}

export function buildExperienceMessage(m: ExperienceMessageInput): string {
  return [
    `Target role: ${m.research.targetRole}`,
    ...careerSection(m.roster, m.careerLines),
    ...targetsSection(m.atsTargets),
    ...evidenceSections(m),
    ...rewriteSection(m),
  ].join('\n');
}
```

- [ ] **Step 4: Run -- PASS.** Adjust ONLY formatting details if `verifiedMatches` field names differ (read `StrategistResearchResult` in `shared/src/strategist-types.ts` and use the real field names; keep the section headers exactly as tested).
- [ ] **Step 5: Lint + tsc + commit** `feat(job-strategist): experience agent message -- indexed lines, grouped targets, metrics`

### Task 4: persona + prompt module + `executeExperienceAgent`

**Files:**
- Create: `applications/job-strategist/src/prompts/content/strategist/experience-agent.md`
- Modify: `applications/job-strategist/src/prompts/prompt-manifest.json` (add `strategist/experience-agent` entry)
- Create: `applications/job-strategist/src/prompts/strategist-experience.ts`
- Create: `applications/job-strategist/src/agents/writer/experience-agent.ts`
- Test: `applications/job-strategist/src/agents/writer/__tests__/experience-agent.test.ts`, extend `applications/job-strategist/src/prompts/__tests__/` with `strategist-experience-persona.test.ts`

**Interfaces:**
- Produces: `executeExperienceAgent(ctx: StrategistPipelineContext, input: ExperienceMessageInput, opts?: { agentName?: AgentName }): Promise<AgentResult<ExperienceAgentOutput>>`.

- [ ] **Step 1: Write `experience-agent.md`** (frontmatter `id: strategist-experience`, `version: 1`, `cachePoint: default`). Body -- profile-voice rules moved from today's `experience.md` plus the provenance contract, ASCII only:

```text
ROLE: you are the dedicated Experience composer. You receive the candidate's
career history as INDEXED SOURCE LINES plus JD requirements, ATS targets,
verified evidence, and grounded metrics. You REWRITE and REORDER the
candidate's own lines into a JD-tailored profile -- you never invent work.

PROVENANCE CONTRACT (hard): every bullet's `sources` cites the line id(s) it
was rewritten from -- same employer only. Every input line must appear in some
bullet's sources or in accounting.dropped with a short reason. Company, title,
and period are IMMUTABLE -- reproduce them byte-identically.

PROFILE VOICE, NOT A TASK LIST: each role tells ONE arc against the JD -- the
lead bullet is that role's thesis for THIS position; remaining bullets deepen
it in JD-relevance order (verified matches first). Rewrite in the JD's
vocabulary where a line honestly supports it ("Configured VPC networking and
Route53 DNS" -> networking concepts and protocols work naming DNS/TCP-IP/
SSL-TLS when those targets are attainable). Never stuff a keyword a line does
not support; record honest omissions by leaving the target unwoven.

COMPOSITION (unchanged rules): every bullet 32 words max, ONE sentence,
verb-first, dry; one number per bullet (two only for a before/after pair) and
ONLY from Grounded Metrics or the source line itself, verbatim; every
implementation bullet ends with its impact clause (measured when the ledger
has it, established qualitative benefit otherwise); 3-5 bullets per role, hard
max 5, minimum 2 whenever the career history provides two distinct grounded
facts; add "solo-operated" or "self-managed" to any bullet that could imply
enterprise scale. Experience section total: 370 words max.

Emit ONLY via the emit_experience tool.
```

- [ ] **Step 2: Register the manifest entry.** Run `yarn workspace @bedrock/job-strategist test -- prompt-content-integrity`; it FAILS printing the required entry for `strategist/experience-agent`; add `{ "version": "1", "sha256": "<printed>" }` to `prompt-manifest.json`; re-run -> PASS.
- [ ] **Step 3: Create `strategist-experience.ts`** (mirror of `strategist-summary.ts`):

```typescript
/** @format */
import type { SystemContentBlock } from '@aws-sdk/client-bedrock-runtime';
import { loadPersona, type PromptMeta } from './prompt-loader.js';

const loaded = loadPersona('strategist/experience-agent');
export const STRATEGIST_EXPERIENCE_META: PromptMeta = loaded.meta;
export const STRATEGIST_EXPERIENCE_SYSTEM_PROMPT: SystemContentBlock[] = loaded.blocks;
```

- [ ] **Step 4: Failing agent test** (mirror `summary-agent.test.ts`'s mocked-runAgent pattern -- READ that file first and copy its mocking approach):

```typescript
// asserts: (1) config uses agentName 'strategist-experience', forced tool 'emit_experience',
//          thinkingBudget 0; (2) opts.agentName overrides to 'strategist-experience-rewrite';
//          (3) parseResponse validates via ExperienceAgentOutputSchema (malformed -> throws).
```

Write real assertions following the existing summary-agent test structure; no assertion-free tests.

- [ ] **Step 5: Implement `experience-agent.ts`**

```typescript
/** @format */
import {
  runAgent, parseJsonResponse,
  type AgentConfig, type AgentName, type AgentResult, type StrategistPipelineContext,
} from '@bedrock/shared';
import { STRATEGIST_EXPERIENCE_META, STRATEGIST_EXPERIENCE_SYSTEM_PROMPT } from '../../prompts/strategist-experience.js';
import { ExperienceAgentOutputSchema, EXPERIENCE_EMIT_INPUT_SCHEMA, type ExperienceAgentOutput } from './experience-schema.js';
import { buildExperienceMessage, type ExperienceMessageInput } from './experience-message.js';

const MODEL = process.env['STRATEGIST_MODEL'] ?? 'eu.anthropic.claude-sonnet-4-6';
const EFFECTIVE_MODEL_ID = process.env['INFERENCE_PROFILE_ARN'] ?? MODEL;

/** Forced tool + thinkingBudget 0: constrained decoding, and the payload can
 *  safely carry the metrics ledger (the 2026-07-08 thinking blowup applied to
 *  the extended-thinking writer, not forced-tool calls). */
const EXPERIENCE_CONFIG: AgentConfig = {
  agentName: 'strategist-experience',
  modelId: EFFECTIVE_MODEL_ID,
  maxTokens: 4000,
  thinkingBudget: 0,
  systemPrompt: STRATEGIST_EXPERIENCE_SYSTEM_PROMPT,
  pipeline: 'job-strategist',
  promptId: STRATEGIST_EXPERIENCE_META.id,
  promptVersion: STRATEGIST_EXPERIENCE_META.version,
  tool: {
    name: 'emit_experience',
    description: 'Emit the tailored experience section with per-bullet source citations and line accounting.',
    inputSchema: EXPERIENCE_EMIT_INPUT_SCHEMA,
  },
};

export async function executeExperienceAgent(
  ctx: StrategistPipelineContext,
  input: ExperienceMessageInput,
  opts?: { agentName?: AgentName },
): Promise<AgentResult<ExperienceAgentOutput>> {
  const config = opts?.agentName ? { ...EXPERIENCE_CONFIG, agentName: opts.agentName } : EXPERIENCE_CONFIG;
  return runAgent<ExperienceAgentOutput>({
    config,
    userMessage: buildExperienceMessage(input),
    parseResponse: (text) => ExperienceAgentOutputSchema.parse(parseJsonResponse<unknown>(text, 'strategist-experience')),
    pipelineContext: {
      pipelineId: ctx.pipelineId,
      environment: ctx.environment,
      cumulativeTokens: ctx.cumulativeTokens,
      cumulativeCostUsd: ctx.cumulativeCostUsd,
    },
  });
}
```

- [ ] **Step 6: Persona pin test** (`strategist-experience-persona.test.ts`, mirror the summary persona test's loading pattern): assert the loaded persona contains `PROVENANCE CONTRACT`, `PROFILE VOICE`, `32 words`, and `emit_experience`.
- [ ] **Step 7: Run all new tests + integrity -- PASS; lint .ts files; tsc; commit** `feat(job-strategist): dedicated experience agent -- persona, forced tool, provenance contract`

### Task 5: AgentName additions

**Files:**
- Modify: `applications/shared/src/types.ts` (`AgentName` union, line ~136)

- [ ] **Step 1:** append `| 'strategist-experience' | 'strategist-experience-rewrite'` after `'strategist-summary-rewrite'` on the strategist line, matching formatting.
- [ ] **Step 2:** `yarn workspace @bedrock/shared exec tsc --noEmit` + `yarn workspace @bedrock/shared build` (dist needed by job-strategist; gitignored, do not commit) + `yarn workspace @bedrock/job-strategist exec tsc --noEmit` -- all clean.
- [ ] **Step 3:** `yarn eslint applications/shared/src/types.ts`; commit ONLY types.ts: `feat(shared): experience agent names for isolated cost`

### Task 6: `experience-ats-flow.ts` -- resolveExperienceAts

**Files:**
- Create: `applications/job-strategist/src/agents/writer/experience-ats-flow.ts`
- Test: `applications/job-strategist/src/agents/writer/__tests__/experience-ats-flow.test.ts`

**Interfaces:**
- Consumes: `scoreSummaryCoverage` (REUSE), `validateExperienceProvenance`/`assembleExperience`/`IndexedCareerLine`/`RosterEntry` (Task 2), `ExperienceAtsTarget` (Task 1), `namesGap` (`../quality/guards/summary-rules.js`).
- Produces:

```typescript
export interface ExperienceAgentDiagnostics {
  readonly targets: ExperienceAtsTarget[];
  readonly coverageBefore: SummaryCoverage;
  readonly rewrite: { fired: boolean; reason: string | null; coverageAfter: SummaryCoverage | null;
                      kept: 'first' | 'rewrite' | null; keptReason: string | null };
  readonly fallback: { fired: boolean; reason: string | null };
  readonly provenance: { firstViolations: string[]; rewriteViolations: string[]; droppedLines: number };
}
export function resolveExperienceAts(params: {
  first: ExperienceAgentOutput; roster; careerLines; targets;
  rewrite: (draftText: string, missing: string[]) => Promise<ExperienceAgentOutput>;
}): Promise<{ output: ExperienceAgentOutput; diag: ExperienceAgentDiagnostics }>;
```

PRECONDITION (document in the doc comment): the caller has already validated the FIRST pass -- an invalid/errored first pass never reaches this function (it goes to the verbatim-career fallback instead). Fire rule: re-write when `targets.length > 0 && covered < targets.length`. Guard for the KEPT candidate: re-write must be provenance-valid AND no bullet trips `namesGap`; otherwise keep first. Keep rule mirrors `decideKeep`: prefer valid rewrite when it covers MORE; tie/no-gain/invalid/throw -> first.

- [ ] **Step 1: Failing test** -- five cases with a stub rewrite fn (mirror the summary flow test structure, but outputs are `ExperienceAgentOutput` fixtures reusing Task 2's `good` shape):
  1. covered<targets + valid rewrite covering more -> kept 'rewrite'.
  2. rewrite gains nothing -> kept 'first', keptReason 'no-coverage-gain'.
  3. coverage already full -> rewrite fn never called, fired=false, reason 'coverage-met'.
  4. rewrite throws -> kept 'first', reason 'rewrite-error'.
  5. rewrite provenance-invalid (cite another role's line) -> kept 'first', keptReason 'rewrite-provenance-invalid', violations recorded in `diag.provenance.rewriteViolations`.
  Score text = joined `assembleExperience(output)` highlights. Write complete fixtures (career lines DNS/TCP-IP style so coverage is controllable via bullet text).
- [ ] **Step 2: Run -- FAIL.**
- [ ] **Step 3: Implement** -- structure copied from `summary-ats-flow.ts` (read it first): early-return helper producing the no-rewrite diagnostics; try/catch around `params.rewrite`; `decideKeepExperience(firstCovered, rewriteCovered, rewriteValid)` extracted to keep complexity <=10; `joinExperienceText(out) = assembleExperience(out).flatMap(r => r.highlights).join('. ')`; guard check `namesGap` per bullet + `validateExperienceProvenance` on the rewrite. The draft text passed to the rewrite fn = per-role `company | title` header + `- bullet` lines.
- [ ] **Step 4: Run -- PASS (5/5); lint; tsc; commit** `feat(job-strategist): experience ATS lane -- strict coverage + one bounded provenance-guarded re-write`

### Task 7: writer skeleton personas + `fillResumeExperience` wiring + weave scoping

**Files:**
- Modify: `applications/job-strategist/src/prompts/content/strategist/experience.md` (rewrite: skeleton rule; bump version)
- Modify: `applications/job-strategist/src/prompts/content/strategist/_base_1.md` (XML skeleton comment + employment-fidelity wording; bump version)
- Modify: `applications/job-strategist/src/prompts/content/strategist/_base_3.md` (word-budget line; bump version)
- Modify: `applications/job-strategist/src/prompts/content/strategist/_base_4.md` (trim-order/scope-qualifier lines that reference experience bullets; bump version)
- Modify: `applications/job-strategist/src/prompts/prompt-manifest.json` (4 hash+version updates)
- Modify: `applications/job-strategist/src/run-pipeline.ts` (new splice + weave scoping)
- Test: extend `applications/job-strategist/src/agents/writer/__tests__/experience-ats-flow.test.ts` is NOT touched here; new test `applications/job-strategist/src/__tests__/experience-weave-scope.test.ts` for the restore helper

Persona changes (exact directives):
- `experience.md` becomes the skeleton rule (replace the bullet-authoring body; those rules now live in `experience-agent.md`):
  ```text
  EXPERIENCE -- ROSTER SKELETON ONLY: emit each entry from "Verified
  Experience" with its exact company, title, and period and highlights: []
  (empty array). Do NOT compose experience bullets -- a dedicated experience
  pass authors them after this body is generated. Never invent, rename,
  merge, or drop a role.
  ```
- `_base_1.md`: change the XML skeleton comment for experience to `<!-- highlights: [] -- a dedicated experience pass fills bullets after this body -->` and reword rule 1b so employment fidelity now binds the roster (company/title/period) rather than bullet authorship.
- `_base_3.md`: replace the experience word-budget line with "experience: roster skeleton only -- word budget enforced by the experience pass".
- `_base_4.md`: drop the experience-bullet trim-order/scope-qualifier lines (they move to `experience-agent.md`; the trim order retains its non-experience entries).

run-pipeline wiring (insert AFTER the `reconcileRosterAgainstCareer` block ~1106-1120 and BEFORE the summary splice ~1123; READ the real code first and adapt names):

```typescript
// -- Experience agent -- rewrites the user's indexed career lines against the JD --
const experienceAtsTargets = selectExperienceAtsTargets(skillEvidenceLedger, jdExtraction, 6);
const experienceAgentDiag = await fillResumeExperience(
  ctx, tailoredResumeData, researchData, careerEntries, experienceAtsTargets,
  groundedMetricsBlock, codeStackContext, experienceOutcomeMetric,
  (err) => log.warn({ pipelineRunId: env.pipelineRunId, agent: 'strategist-experience',
    err: err instanceof Error ? err.message : String(err) }, 'experience_agent_failed_verbatim_fallback_used'),
);
```

`fillResumeExperience` (new module-level fn beside `fillResumeSummary`, same shape):

```typescript
async function fillResumeExperience(
  ctx: StrategistPipelineContext,
  tailoredResumeData: StructuredResumeData | null,
  researchData: StrategistResearchResult,
  careerEntries: readonly CareerEntry[],
  atsTargets: readonly ExperienceAtsTarget[],
  groundedMetrics: string,
  codeStack: string,
  metric: Counter<'outcome'>,
  onFallback: (err: unknown) => void,
): Promise<ExperienceAgentDiagnostics | null> {
  if (!tailoredResumeData || careerEntries.length === 0) return null;
  const roster = rosterFromCareer(careerEntries);
  const careerLines = indexCareerLines(careerEntries);
  const baseInput = { research: researchData, roster, careerLines, atsTargets, groundedMetrics, codeStack };
  const verbatim = () => careerEntries.map((e) => ({
    company: e.company, title: e.title, period: e.period, highlights: e.highlights.slice(0, 5),
  }));
  try {
    const first = await executeExperienceAgent(ctx, baseInput);
    const firstViolations = validateExperienceProvenance(first.data, roster, careerLines);
    if (firstViolations.length > 0) throw new ExperienceProvenanceError(firstViolations);
    const { output, diag } = await resolveExperienceAts({
      first: first.data, roster, careerLines, targets: atsTargets,
      rewrite: async (draftText, missing) => {
        const rw = await executeExperienceAgent(ctx,
          { ...baseInput, rewriteDraft: draftText, rewriteMissing: missing },
          { agentName: 'strategist-experience-rewrite' });
        return rw.data;
      },
    });
    (tailoredResumeData as { experience: unknown }).experience = assembleExperience(output);
    metric.inc({ outcome: 'agent' });
    return diag;
  } catch (err) {
    (tailoredResumeData as { experience: unknown }).experience = verbatim();
    metric.inc({ outcome: 'fallback' });
    onFallback(err);
    return { targets: [...atsTargets],
      coverageBefore: { targets: atsTargets.length, covered: 0, missing: atsTargets.map((t) => t.skill) },
      rewrite: { fired: false, reason: null, coverageAfter: null, kept: null, keptReason: null },
      fallback: { fired: true, reason: err instanceof Error ? err.message : String(err) },
      provenance: { firstViolations: err instanceof ExperienceProvenanceError ? err.violations : [], rewriteViolations: [], droppedLines: 0 } };
  }
}
```

`ExperienceProvenanceError` = small class `{ violations: string[] }` in `experience-provenance.ts` (add in this task, with a one-line test).

Weave scoping (spec rule -- `surfaceMetrics` also weaves project descriptions, so scope it, do not retire): wrap the existing `weaveGroundedMetrics`/`surfaceMetrics` call so experience is snapshot-restored:

```typescript
/** surfaceMetrics may weave into projects; experience is agent-owned -- restore it. */
function restoreExperienceAfter(resume: StructuredResumeData, before: StructuredResumeData['experience']): StructuredResumeData {
  return { ...resume, experience: before } as StructuredResumeData;
}
```

At the weave call site: capture `const expBefore = structuredClone(finalResume.experience);` before, apply `finalResume = restoreExperienceAfter(woven, expBefore)` after. Unit-test the helper in `experience-weave-scope.test.ts` (restores byte-identically, leaves projects changes intact).

Steps:
- [ ] **Step 1:** persona edits (4 files) + version bumps; run `prompt-content-integrity` -> paste 4 printed hashes -> PASS.
- [ ] **Step 2:** failing test for `restoreExperienceAfter` (pure).
- [ ] **Step 3:** implement wiring above (imports: `selectExperienceAtsTargets`, `resolveExperienceAts`, `rosterFromCareer`/`indexCareerLines`/`assembleExperience`/`validateExperienceProvenance`/`ExperienceProvenanceError`, `executeExperienceAgent`; define `experienceOutcomeMetric` Counter `job_strategist_experience_agent_outcome_total` help 'Experience agent outcomes: agent vs fallback.' labels `['outcome']` beside the summary one -- Task 8 adds the richer metrics).
- [ ] **Step 4:** full suite green (`yarn workspace @bedrock/job-strategist test`); note ANY existing test that asserted writer-authored experience bullets and adapt those tests' fixtures to the skeleton contract (report each change).
- [ ] **Step 5:** lint changed .ts; tsc both workspaces; commit `feat(job-strategist): experience agent splice -- writer emits roster skeleton, agent authors bullets`

### Task 8: observability -- Loki events, metadata fold, metrics

**Files:**
- Create: `applications/job-strategist/src/agents/writer/experience-agent-diagnostics.ts`
- Test: `applications/job-strategist/src/agents/writer/__tests__/experience-agent-diagnostics.test.ts`
- Modify: `applications/job-strategist/src/run-pipeline.ts`

Mirror `summary-ats-diagnostics.ts` exactly (READ it first):
- `logExperienceAgentEvents(log, keys, diag)` emitting `experience_agent_targets` / `_scored` / `_rewrite` (if fired) / `_provenance_reject` (once per violation list non-empty, with the tokens) / `_fallback` (if fired) -- every line keyed `pipeline_run_id`/`application_id`/`trace_id` (null).
- `experienceAgentOutcome(diag): {outcome: 'aware'|'rewritten'|'kept_first'|'fallback'; reason: string}` -- BOUNDED reasons; fallback maps to fixed `'agent-error'` (provenance-invalid first pass maps to `'provenance-invalid'` when `diag.provenance.firstViolations.length > 0`); raw error stays Loki-only.
- run-pipeline: replace the Task-7 plain counter usage with: `logExperienceAgentEvents` + `experienceAgentOutcomeMetric.inc({outcome, reason})` (relabel the Task-7 counter to `['outcome','reason']`) + coverage histogram `job_strategist_experience_agent_coverage` buckets `[0,1,2,3,4,5,6]` observed ONLY when `targets>0 && !fallback.fired` + safety-net counter `job_strategist_experience_net_fired_total{pass}` incremented when a net pass changes experience: compute `JSON.stringify(resume.experience)` before/after `guardResume`, `applyLengthBudget`, and `surfaceKeywords` and inc with `pass` label `'guard' | 'length' | 'surface_keywords'` on inequality (extract helper `expSnapshot(resume): string` to keep `main` complexity flat).
- Fold `experienceAgent: experienceAgentDiag` into the EXISTING `analysis: {...}` metadata write (same object literal as `summaryAts` -- shallow-merge constraint).

Steps: failing tests (event shapes + bounded outcome incl. provenance-invalid mapping) -> implement -> full suite -> lint/tsc -> commit `feat(job-strategist): experience agent observability -- Loki events, metadata fold, bounded metrics, net-fired counters`

### Task 9: evals/experience

**Files:**
- Create: `applications/job-strategist/src/evals/experience/experience-graders.ts`
- Create: `applications/job-strategist/src/evals/experience/fixtures.ts`
- Test: `applications/job-strategist/src/evals/experience/experience-graders.test.ts`

Graders (reuse `mkResult` from `../graders.js`; input type):

```typescript
export interface ExperienceEvalInput {
  readonly output: ExperienceAgentOutput;
  readonly roster: readonly RosterEntry[];
  readonly careerLines: readonly IndexedCareerLine[];
  readonly atsTargets: readonly ExperienceAtsTarget[];
  readonly allowedNumbers: readonly string[]; // ledger + source-line numbers
}
```

- `provenanceGrader` -- `validateExperienceProvenance` returns [] (reuse, do not re-check rules manually).
- `noFabricationGrader` -- every number token (reuse `numbersIn` from `agents/quality/guards/text.js`) in every bullet text appears in `allowedNumbers` or in one of its cited source lines' `numbersIn`.
- `atsCoverageGrader` -- `scoreSummaryCoverage(joined bullets, atsTargets)` covered >= `Math.min(2, atsTargets.length)`; vacuous when no targets.
- `voiceGrader` -- every bullet <= 32 words AND at most 2 number tokens.
- `reorderGrader` -- for each role where ANY bullet matches an ATS target (via the strict `padded`/`normalizeTerm` check from `scoreSummaryCoverage`'s semantics -- just call `scoreSummaryCoverage(bullet, targets).covered > 0` per bullet), the LEAD bullet must be one of the matching bullets.
- `EXPERIENCE_GRADERS` array + `runExperienceGraders` (all pass = pass), mirroring `summary-graders.ts:71-77`.

Fixtures: `GOLDEN_NETWORKING` -- career lines including `Configured VPC networking, security groups and Route53 DNS records` + targets DNS/TCP-IP/SSL-TLS stamped with the composite networking requirement; golden output weaves `DNS` and `SSL/TLS` into the lead AWS bullet with `sources: ['c0.h0']`; passes every grader. Adversarial fixture: bullet citing the wrong role -> provenanceGrader fails; bullet with invented `47%` -> noFabricationGrader fails.

Steps: failing tests (golden passes all; each adversarial fails exactly its grader; vacuous-target case passes atsCoverage) -> implement -> PASS -> lint/tsc -> commit `test(job-strategist): experience eval -- provenance, no-fabrication, ATS networking golden, voice, reorder`

### Task 10: runbook + ledger close-out

**Files:**
- Modify: `docs/runbooks/summary-ats-observability.md` -- OR (preferred) Create: `docs/runbooks/experience-agent-observability.md` mirroring its structure.

- [ ] **Step 1:** write the runbook: surfaces = Prometheus (`job_strategist_experience_agent_outcome_total{outcome,reason}` -- list the bounded reason enum exactly as implemented in Task 8; coverage histogram; `job_strategist_experience_net_fired_total{pass}` with the retirement-decision note), Loki (`{namespace="job-strategist"} | json | event=~"experience_agent_.*"` + per-run replay by `pipeline_run_id`), SQL (`metadata->'analysis'->'experienceAgent'`; fleet query mirroring the summaryAts one), cost (`prompt_invocations WHERE agent LIKE 'strategist-experience%'`). Include "what good looks like": net-fired counters trending to zero = evidence to retire passes; `provenance-invalid` fallbacks = agent prompt problem, check `_provenance_reject` tokens.
- [ ] **Step 2:** ASCII check (`grep -P '[^\x00-\x7F]'` on the file) -> clean; commit `docs(runbooks): experience agent observability -- panels, queries, net-retirement evidence`

---

## Self-Review

**Spec coverage:** roster-skeleton decouple -> T7; provenance schema+validator+assembly -> T2; indexed-lines/targets/metrics message -> T3; agent+persona -> T4; agent names -> T5; full ATS mirror (fire `covered<targets`, provenance guard, decideKeep, verbatim fallback) -> T6+T7; weave scoping rule (surfaceMetrics touches projects too -> snapshot/restore) -> T7; safety-net firing counters -> T8; four observability surfaces -> T8+T10; evals incl. networking golden -> T9. No spec section unmapped.

**Placeholder scan:** T4 Step 4 and T8 describe tests by contract referencing an existing file's structure to copy (`summary-agent.test.ts`, `summary-ats-diagnostics.test.ts` + its Task-6-brief twin) -- acceptable because the referenced files exist in-repo as the executable template; all other steps carry complete code. No TBD/TODO.

**Type consistency:** `ExperienceAtsTarget extends SummaryAtsTarget` (T1) is scored by `scoreSummaryCoverage` (T6, T9) via assignability; `ExperienceAgentOutput`/`IndexedCareerLine`/`RosterEntry` (T2) consumed by T3/T4/T6/T7/T9 under those exact names; `resolveExperienceAts` returns `{output, diag}` consumed in T7; `ExperienceAgentDiagnostics.provenance` field read by T8's outcome mapper; `executeExperienceAgent(ctx, input, opts?)` matches T7's rewrite closure.
