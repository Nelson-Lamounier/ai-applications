# SP0 — Profile Aggregation Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a precomputed per-user `user_profile_rollup` (one row/user) aggregating each user's per-repo `repository_profiles` into languages/domains/complexity/roles/tech/activity/totals, refreshed best-effort at the end of each ingestion job.

**Architecture:** Mirror the shipped `computeKbQuality` / retrieval-probe pattern. `shared` owns a PURE aggregation function (`computeUserProfileRollup`, zero I/O, unit-tested) + a plain RDS repository (interface + impl, RLS via `set_config`). The ingestion app calls a best-effort wrapper after profile extraction completes, inside its own OTel span, that never fails ingestion. SP0 ships no HTTP/UI — the table + documented JSON shape is the contract.

**Tech Stack:** TypeScript, Node, Jest, Postgres (pgvector unused here), `pg`, OpenTelemetry, Postgres migration via `platform-rds-bootstrap`.

Spec: `docs/superpowers/specs/2026-05-19-profile-aggregation-foundation-design.md`

**Environment (every task):** Work in an isolated worktree created at execution time. `WT=<worktree abs path>`. Shell cwd resets between commands and shell state does not persist — EVERY command must be self-contained: use `git -C "$WT" …` for git and `cd "$WT" && yarn …` for yarn (`yarn workspace` has no `-C`; wrong cwd silently runs the MAIN repo). The ingestion package imports the COMPILED `@bedrock/shared` (`dist/`); a fresh worktree has none, so before any ingestion typecheck/test run `cd "$WT" && yarn workspace @bedrock/shared run build`. Shared's own tests run from source (ts-jest) and need no build. `applications/shared/dist/` is gitignored — never stage it. Workspace names: `@bedrock/shared`, `@bedrock/ingestion`. Confirm branch state via `git -C "$WT" rev-parse HEAD`, not `git show <sha>` (shows orphans).

All commits follow the **git-commit skill**: tests + typecheck pass before commit, atomic staging of only the listed files (never `git add .`/`-A`), conventional message, **no `Co-Authored-By`/AI authorship trailer**.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `applications/platform-rds-bootstrap/migrations/024_user_profile_rollup.sql` | `user_profile_rollup` table + RLS (idempotent) | Create |
| `applications/shared/src/rds/profile/computeUserProfileRollup.ts` | Pure types + aggregation fn (zero I/O) | Create |
| `applications/shared/src/rds/profile/computeUserProfileRollup.test.ts` | Pure-fn table tests | Create |
| `applications/shared/src/rds/interfaces/IUserProfileRollupRepository.ts` | Repository contract | Create |
| `applications/shared/src/rds/implementations/RdsUserProfileRollupRepository.ts` | `pg` impl: read all profile rows + upsert rollup (RLS) | Create |
| `applications/shared/src/rds/implementations/RdsUserProfileRollupRepository.test.ts` | Fake-pool tests (RLS, projection, upsert params) | Create |
| `applications/shared/src/rds/index.ts` | Export new symbols | Modify |
| `applications/shared/src/index.ts` | Re-export new symbols | Modify |
| `applications/ingestion/src/util/refreshUserProfileRollup.ts` | Best-effort never-throws refresh wrapper + OTel span | Create |
| `applications/ingestion/src/util/__tests__/refreshUserProfileRollup.test.ts` | never-throws + happy-path tests | Create |
| `applications/ingestion/src/run-ingestion.ts` | Construct repo + call wrapper after profile `completed` | Modify |

**Deliberate spec reconciliation:** the spec's "Repository" testing bullet said the list query WHERE-filters on `classification='project'`, etc. That conflicts with `classificationCounts` needing **all** rows and the spec's stronger statement that the pure fn applies headline scope "in one testable place". This plan resolves it as: **the repository returns ALL of the user's `repository_profiles` rows (no classification/hidden/status filter); the pure `computeUserProfileRollup` applies the headline scope** (`classification==='project' && !isHidden && extractionStatus==='completed'`) and also computes `classificationCounts` over all rows. Single source of truth, fully unit-testable.

---

## Task 1: Migration `024_user_profile_rollup.sql`

**Files:**
- Create: `applications/platform-rds-bootstrap/migrations/024_user_profile_rollup.sql`

Migrations auto-load lexically in `platform-rds-bootstrap/src/index.ts` and the bootstrap Job re-runs every `.sql` each deploy (no version tracking) → must be idempotent. Latest existing is `023_retrieval_quality.sql`.

- [ ] **Step 1: Create the migration file**

```sql
-- 024_user_profile_rollup.sql
-- Per-user aggregate over repository_profiles (SP0 — Profile Aggregation
-- Foundation). One row per user, refreshed best-effort at the end of each
-- ingestion job. Headline aggregates use only classification='project',
-- NOT is_hidden, extraction_status='completed' — applied in
-- computeUserProfileRollup (shared), not in SQL.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS; ENABLE ROW LEVEL SECURITY is
-- idempotent; policy wrapped in DROP POLICY IF EXISTS first (same convention
-- as migrations 003 / 021). Safe to re-run on every bootstrap.

CREATE TABLE IF NOT EXISTS user_profile_rollup (
    user_id             UUID         PRIMARY KEY
                                     REFERENCES users(id) ON DELETE CASCADE,
    project_repo_count  INTEGER      NOT NULL DEFAULT 0,
    total_repo_count    INTEGER      NOT NULL DEFAULT 0,
    methodology_version INTEGER      NOT NULL DEFAULT 1,
    rollup              JSONB        NOT NULL DEFAULT '{}',
    refreshed_at        TIMESTAMPTZ  NOT NULL DEFAULT now()
);

ALTER TABLE user_profile_rollup ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_user_profile_rollup ON user_profile_rollup;
CREATE POLICY rls_user_profile_rollup ON user_profile_rollup
    USING      (user_id = current_setting('app.current_user_id', true)::uuid)
    WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);
```

- [ ] **Step 2: Verify lexical ordering**

Run: `ls applications/platform-rds-bootstrap/migrations/ | sort | tail -3`
Expected: ends `022_semantic_cache.sql`, `023_retrieval_quality.sql`, `024_user_profile_rollup.sql`.

- [ ] **Step 3: Commit**

```bash
git -C "$WT" add applications/platform-rds-bootstrap/migrations/024_user_profile_rollup.sql
git -C "$WT" commit -m "feat(rds): add user_profile_rollup table with RLS"
```

---

## Task 2: Pure module `computeUserProfileRollup` + types + barrels

**Files:**
- Create: `applications/shared/src/rds/profile/computeUserProfileRollup.ts`
- Create: `applications/shared/src/rds/profile/computeUserProfileRollup.test.ts`
- Modify: `applications/shared/src/rds/index.ts`
- Modify: `applications/shared/src/index.ts`

PURE: zero I/O, no Bedrock, deterministic — twin of `applications/shared/src/rds/quality/computeKbQuality.ts` (read it first to match `@format` header + house style).

- [ ] **Step 1: Write the failing test**

Create `applications/shared/src/rds/profile/computeUserProfileRollup.test.ts`:

```ts
import { computeUserProfileRollup } from './computeUserProfileRollup.js';
import type { ProfileAggInput } from './computeUserProfileRollup.js';

function row(p: Partial<ProfileAggInput> = {}): ProfileAggInput {
    return {
        repoFullName:     'o/r',
        classification:   'project',
        isHidden:         false,
        extractionStatus: 'completed',
        primaryLanguage:  'TypeScript',
        commitCount:      10,
        lastActiveAt:     '2026-01-01T00:00:00Z',
        domain:           'infra',
        complexity:       'moderate',
        roleInferred:     'creator',
        techStack:        ['AWS', 'Kubernetes'],
        ...p,
    };
}

describe('computeUserProfileRollup — scope', () => {
    it('headline aggregates only project + !hidden + completed', () => {
        const res = computeUserProfileRollup([
            row({ repoFullName: 'o/a' }),
            row({ repoFullName: 'o/b', classification: 'fork' }),
            row({ repoFullName: 'o/c', isHidden: true }),
            row({ repoFullName: 'o/d', extractionStatus: 'failed' }),
        ]);
        expect(res.projectRepoCount).toBe(1);
        expect(res.totalRepoCount).toBe(4);
        expect(res.rollup.totals.projectRepoCount).toBe(1);
    });

    it('classificationCounts reflects ALL rows incl. hidden', () => {
        const res = computeUserProfileRollup([
            row({ classification: 'project' }),
            row({ classification: 'fork' }),
            row({ classification: 'tutorial', isHidden: true }),
        ]);
        expect(res.rollup.classificationCounts.project).toBe(1);
        expect(res.rollup.classificationCounts.fork).toBe(1);
        expect(res.rollup.classificationCounts.tutorial).toBe(1);
        expect(res.rollup.classificationCounts.hiddenCount).toBe(1);
    });
});

describe('computeUserProfileRollup — aggregates', () => {
    it('ranks languages by commit-volume proxy with sharePct', () => {
        const res = computeUserProfileRollup([
            row({ repoFullName: 'o/a', primaryLanguage: 'TypeScript', commitCount: 30 }),
            row({ repoFullName: 'o/b', primaryLanguage: 'TypeScript', commitCount: 10 }),
            row({ repoFullName: 'o/c', primaryLanguage: 'Python',     commitCount: 10 }),
        ]);
        expect(res.rollup.languages[0]).toEqual({
            language: 'TypeScript', repoCount: 2, commitVolumeProxy: 40, sharePct: 80,
        });
        expect(res.rollup.languages[1]).toEqual({
            language: 'Python', repoCount: 1, commitVolumeProxy: 10, sharePct: 20,
        });
    });

    it('null primary language buckets as "unknown"', () => {
        const res = computeUserProfileRollup([row({ primaryLanguage: null, commitCount: 5 })]);
        expect(res.rollup.languages[0].language).toBe('unknown');
    });

    it('domains: counts + dominant', () => {
        const res = computeUserProfileRollup([
            row({ repoFullName: 'o/a', domain: 'infra' }),
            row({ repoFullName: 'o/b', domain: 'infra' }),
            row({ repoFullName: 'o/c', domain: 'web' }),
        ]);
        expect(res.rollup.domains.counts).toEqual({ infra: 2, web: 1 });
        expect(res.rollup.domains.dominant).toBe('infra');
    });

    it('complexity + roles counts', () => {
        const res = computeUserProfileRollup([
            row({ repoFullName: 'o/a', complexity: 'complex', roleInferred: 'creator' }),
            row({ repoFullName: 'o/b', complexity: 'simple',  roleInferred: 'contributor' }),
        ]);
        expect(res.rollup.complexity).toEqual({ simple: 1, moderate: 0, complex: 1 });
        expect(res.rollup.roles).toEqual({ creator: 1, maintainer: 0, contributor: 1 });
    });

    it('techStackTop frequency, ranked, name tiebreak', () => {
        const res = computeUserProfileRollup([
            row({ repoFullName: 'o/a', techStack: ['AWS', 'Docker'] }),
            row({ repoFullName: 'o/b', techStack: ['AWS', 'Zod'] }),
        ]);
        expect(res.rollup.techStackTop[0]).toEqual({ tech: 'AWS', repoCount: 2 });
        // Docker and Zod both repoCount 1 → alphabetical
        expect(res.rollup.techStackTop.slice(1)).toEqual([
            { tech: 'Docker', repoCount: 1 },
            { tech: 'Zod',    repoCount: 1 },
        ]);
    });

    it('activityArc ascending; null lastActiveAt excluded; activeYearsApprox', () => {
        const res = computeUserProfileRollup([
            row({ repoFullName: 'o/late', lastActiveAt: '2026-01-01T00:00:00Z' }),
            row({ repoFullName: 'o/early', lastActiveAt: '2024-01-01T00:00:00Z' }),
            row({ repoFullName: 'o/none', lastActiveAt: null }),
        ]);
        expect(res.rollup.activityArc.map(e => e.repoFullName)).toEqual(['o/early', 'o/late']);
        expect(res.rollup.totals.earliestActivity).toBe('2024-01-01T00:00:00Z');
        expect(res.rollup.totals.latestActivity).toBe('2026-01-01T00:00:00Z');
        expect(res.rollup.totals.activeYearsApprox).toBe(2);
    });

    it('empty input → deterministic empty rollup, still well-formed', () => {
        const res = computeUserProfileRollup([]);
        expect(res).toMatchObject({
            projectRepoCount: 0, totalRepoCount: 0, methodologyVersion: 1,
        });
        expect(res.rollup.languages).toEqual([]);
        expect(res.rollup.domains).toEqual({ counts: {}, dominant: null });
        expect(res.rollup.totals.activeYearsApprox).toBe(0);
        expect(res.rollup.methodology.version).toBe(1);
    });

    it('is deterministic for the same input', () => {
        const input = [row({ repoFullName: 'o/a' }), row({ repoFullName: 'o/b', primaryLanguage: 'Go' })];
        expect(computeUserProfileRollup(input)).toEqual(computeUserProfileRollup(input));
    });
});
```

- [ ] **Step 2: Run test, confirm it FAILS**

Run: `cd "$WT" && yarn workspace @bedrock/shared run test --no-cache src/rds/profile/computeUserProfileRollup.test.ts`
Expected: FAIL — `Cannot find module './computeUserProfileRollup.js'`.

- [ ] **Step 3: Create `applications/shared/src/rds/profile/computeUserProfileRollup.ts`**

```ts
/**
 * @format
 * computeUserProfileRollup — Pure per-user aggregate over repository_profiles.
 *
 * SP0 of the Profile Intelligence initiative. Twin of computeKbQuality:
 * zero I/O, no Bedrock, deterministic. Headline aggregates use only
 * classification='project' && !isHidden && extractionStatus='completed';
 * classificationCounts is computed over ALL input rows so later sub-projects
 * (e.g. Reveal external-contribution) are not blocked by this narrow scope.
 *
 * "Commit volume" is a proxy: Σ per-repo commit_count grouped by the repo's
 * primary_language. Not line-level. methodology.* labels this honestly so
 * downstream LLM copy does not overclaim.
 */

export interface ProfileAggInput {
    readonly repoFullName:     string;
    readonly classification:   string;          // project|fork|tutorial|abandoned|noise|stale
    readonly isHidden:         boolean;
    readonly extractionStatus: string;          // pending|extracting|ready_for_review|completed|failed
    readonly primaryLanguage:  string | null;
    readonly commitCount:      number;
    readonly lastActiveAt:     string | null;   // ISO 8601 or null
    readonly domain:           string;          // web|ml|devops|infra|mobile|data|cli|lib|other
    readonly complexity:       string;          // simple|moderate|complex
    readonly roleInferred:     string;          // creator|maintainer|contributor
    readonly techStack:        readonly string[];
}

export interface LanguageStat {
    readonly language:          string;
    readonly repoCount:         number;
    readonly commitVolumeProxy: number;
    readonly sharePct:          number;         // 0..100, 2dp
}
export interface TechStat { readonly tech: string; readonly repoCount: number; }
export interface ActivityArcEntry {
    readonly repoFullName:    string;
    readonly lastActiveAt:    string;
    readonly primaryLanguage: string | null;
    readonly domain:          string;
}

export interface UserProfileRollup {
    readonly version: 1;
    readonly languages: LanguageStat[];
    readonly domains: { readonly counts: Record<string, number>; readonly dominant: string | null };
    readonly complexity: { readonly simple: number; readonly moderate: number; readonly complex: number };
    readonly roles: { readonly creator: number; readonly maintainer: number; readonly contributor: number };
    readonly techStackTop: TechStat[];
    readonly activityArc: ActivityArcEntry[];
    readonly totals: {
        readonly projectRepoCount:       number;
        readonly totalCommitVolumeProxy: number;
        readonly earliestActivity:       string | null;
        readonly latestActivity:         string | null;
        readonly activeYearsApprox:      number;
    };
    readonly classificationCounts: Record<string, number> & { readonly hiddenCount: number };
    readonly methodology: {
        readonly version: 1;
        readonly commitVolume: string;
        readonly domainMix: string;
        readonly scope: string;
        readonly confidence: string;
    };
}

export interface UserProfileRollupResult {
    readonly projectRepoCount:   number;
    readonly totalRepoCount:     number;
    readonly methodologyVersion: number;
    readonly rollup:             UserProfileRollup;
}

const COMPLEXITY_KEYS = ['simple', 'moderate', 'complex'] as const;
const ROLE_KEYS       = ['creator', 'maintainer', 'contributor'] as const;

function round2(n: number): number { return Math.round(n * 100) / 100; }
function round1(n: number): number { return Math.round(n * 10) / 10; }

function isQualifying(r: ProfileAggInput): boolean {
    return r.classification === 'project'
        && !r.isHidden
        && r.extractionStatus === 'completed';
}

const METHODOLOGY: UserProfileRollup['methodology'] = {
    version:      1,
    commitVolume: 'primary-language commit-count proxy (not per-line)',
    domainMix:    'repo-count share',
    scope:        'classification=project, !hidden, completed',
    confidence:   'aggregates derived from per-repo profile signals; language ranking is a commit-count proxy, not line-level',
};

export function computeUserProfileRollup(
    rows: readonly ProfileAggInput[],
): UserProfileRollupResult {
    const qualifying = rows.filter(isQualifying);

    // ----- languages (commit-volume proxy) -------------------------------
    const langMap = new Map<string, { repoCount: number; proxy: number }>();
    for (const r of qualifying) {
        const lang = r.primaryLanguage && r.primaryLanguage.length > 0
            ? r.primaryLanguage : 'unknown';
        const e = langMap.get(lang) ?? { repoCount: 0, proxy: 0 };
        e.repoCount += 1;
        e.proxy     += Number.isFinite(r.commitCount) ? r.commitCount : 0;
        langMap.set(lang, e);
    }
    const totalProxy = [...langMap.values()].reduce((s, e) => s + e.proxy, 0);
    const languages: LanguageStat[] = [...langMap.entries()]
        .map(([language, e]) => ({
            language,
            repoCount:         e.repoCount,
            commitVolumeProxy: e.proxy,
            sharePct:          totalProxy > 0 ? round2((e.proxy / totalProxy) * 100) : 0,
        }))
        .sort((a, b) =>
            b.commitVolumeProxy - a.commitVolumeProxy ||
            a.language.localeCompare(b.language));

    // ----- domains -------------------------------------------------------
    const domainCounts: Record<string, number> = {};
    for (const r of qualifying) {
        if (!r.domain) continue;
        domainCounts[r.domain] = (domainCounts[r.domain] ?? 0) + 1;
    }
    let dominant: string | null = null;
    let dominantN = -1;
    for (const [d, n] of Object.entries(domainCounts).sort((a, b) => a[0].localeCompare(b[0]))) {
        if (n > dominantN) { dominant = d; dominantN = n; }
    }

    // ----- complexity / roles -------------------------------------------
    const complexity = { simple: 0, moderate: 0, complex: 0 };
    const roles      = { creator: 0, maintainer: 0, contributor: 0 };
    for (const r of qualifying) {
        if ((COMPLEXITY_KEYS as readonly string[]).includes(r.complexity)) {
            complexity[r.complexity as (typeof COMPLEXITY_KEYS)[number]] += 1;
        }
        if ((ROLE_KEYS as readonly string[]).includes(r.roleInferred)) {
            roles[r.roleInferred as (typeof ROLE_KEYS)[number]] += 1;
        }
    }

    // ----- tech stack ----------------------------------------------------
    const techMap = new Map<string, number>();
    for (const r of qualifying) {
        for (const t of r.techStack ?? []) {
            techMap.set(t, (techMap.get(t) ?? 0) + 1);
        }
    }
    const techStackTop: TechStat[] = [...techMap.entries()]
        .map(([tech, repoCount]) => ({ tech, repoCount }))
        .sort((a, b) => b.repoCount - a.repoCount || a.tech.localeCompare(b.tech));

    // ----- activity arc + totals ----------------------------------------
    const dated = qualifying
        .filter(r => r.lastActiveAt != null && r.lastActiveAt.length > 0)
        .sort((a, b) =>
            a.lastActiveAt!.localeCompare(b.lastActiveAt!) ||
            a.repoFullName.localeCompare(b.repoFullName));
    const activityArc: ActivityArcEntry[] = dated.map(r => ({
        repoFullName:    r.repoFullName,
        lastActiveAt:    r.lastActiveAt!,
        primaryLanguage: r.primaryLanguage,
        domain:          r.domain,
    }));
    const earliestActivity = dated.length > 0 ? dated[0].lastActiveAt! : null;
    const latestActivity   = dated.length > 0 ? dated[dated.length - 1].lastActiveAt! : null;
    let activeYearsApprox = 0;
    if (dated.length >= 2 && earliestActivity && latestActivity) {
        const ms = new Date(latestActivity).getTime() - new Date(earliestActivity).getTime();
        activeYearsApprox = round1(ms / (365.25 * 24 * 60 * 60 * 1000));
    }

    // ----- classification counts (ALL rows) -----------------------------
    const classificationCounts: Record<string, number> & { hiddenCount: number } =
        { hiddenCount: 0 } as Record<string, number> & { hiddenCount: number };
    for (const r of rows) {
        classificationCounts[r.classification] =
            (classificationCounts[r.classification] ?? 0) + 1;
        if (r.isHidden) classificationCounts.hiddenCount += 1;
    }

    const rollup: UserProfileRollup = {
        version: 1,
        languages,
        domains: { counts: domainCounts, dominant },
        complexity,
        roles,
        techStackTop,
        activityArc,
        totals: {
            projectRepoCount:       qualifying.length,
            totalCommitVolumeProxy: totalProxy,
            earliestActivity,
            latestActivity,
            activeYearsApprox,
        },
        classificationCounts,
        methodology: METHODOLOGY,
    };

    return {
        projectRepoCount:   qualifying.length,
        totalRepoCount:     rows.length,
        methodologyVersion: 1,
        rollup,
    };
}
```

- [ ] **Step 4: Run test, confirm PASS**

Run: `cd "$WT" && yarn workspace @bedrock/shared run test --no-cache src/rds/profile/computeUserProfileRollup.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Add barrel exports**

In `applications/shared/src/rds/index.ts`, immediately after the `computeKbQuality` export block (the `export { computeKbQuality } from './quality/computeKbQuality.js';` and its `export type { … }`), add:

```ts
export { computeUserProfileRollup } from './profile/computeUserProfileRollup.js';
export type {
    ProfileAggInput,
    LanguageStat,
    TechStat,
    ActivityArcEntry,
    UserProfileRollup,
    UserProfileRollupResult,
} from './profile/computeUserProfileRollup.js';
```

In `applications/shared/src/index.ts`, find the value re-export block `export { … } from './rds/index.js';` and add `computeUserProfileRollup`; in the adjacent `export type { … } from './rds/index.js';` block add `ProfileAggInput, LanguageStat, TechStat, ActivityArcEntry, UserProfileRollup, UserProfileRollupResult`. Match existing list formatting; do not reorder existing entries.

- [ ] **Step 6: Typecheck + commit**

Run: `cd "$WT" && yarn workspace @bedrock/shared run typecheck`
Expected: PASS.

```bash
git -C "$WT" add applications/shared/src/rds/profile/computeUserProfileRollup.ts applications/shared/src/rds/profile/computeUserProfileRollup.test.ts applications/shared/src/rds/index.ts applications/shared/src/index.ts
git -C "$WT" commit -m "feat(rds): add pure computeUserProfileRollup aggregation"
```

---

## Task 3: Repository — interface + RDS impl + tests

**Files:**
- Create: `applications/shared/src/rds/interfaces/IUserProfileRollupRepository.ts`
- Create: `applications/shared/src/rds/implementations/RdsUserProfileRollupRepository.ts`
- Create: `applications/shared/src/rds/implementations/RdsUserProfileRollupRepository.test.ts`
- Modify: `applications/shared/src/rds/index.ts`
- Modify: `applications/shared/src/index.ts`

Mirror `applications/ingestion/src/repositories/RepositoryProfileRepository.ts` (Pool, `client.connect()`, `BEGIN`, `set_config('app.current_user_id', $1, true)`) for RLS. Read it first. The list query returns **all** of the user's `repository_profiles` rows (no classification/hidden/status filter — the pure fn scopes).

- [ ] **Step 1: Write the failing test**

Create `applications/shared/src/rds/implementations/RdsUserProfileRollupRepository.test.ts`:

```ts
import { RdsUserProfileRollupRepository } from './RdsUserProfileRollupRepository.js';
import type { UserProfileRollupResult } from '../profile/computeUserProfileRollup.js';

function fakeClient(rows: unknown[]) {
    const calls: { sql: string; params: unknown[] }[] = [];
    return {
        calls,
        query: jest.fn(async (sql: string, params?: unknown[]) => {
            calls.push({ sql, params: params ?? [] });
            if (/SELECT[\s\S]*FROM repository_profiles/i.test(sql)) return { rows };
            return { rows: [] };
        }),
        release: jest.fn(),
    };
}
function fakePool(client: ReturnType<typeof fakeClient>) {
    return { connect: jest.fn(async () => client) } as never;
}

const sampleRollup: UserProfileRollupResult = {
    projectRepoCount: 2, totalRepoCount: 3, methodologyVersion: 1,
    rollup: { version: 1 } as never,
};

describe('RdsUserProfileRollupRepository.listProfilesForRollup', () => {
    it('sets RLS user then SELECTs all profile rows (no classification filter)', async () => {
        const client = fakeClient([{
            repoFullName: 'o/r', classification: 'project', isHidden: false,
            extractionStatus: 'completed', primaryLanguage: 'TypeScript',
            commitCount: 5, lastActiveAt: null, domain: 'infra',
            complexity: 'simple', roleInferred: 'creator', techStack: ['AWS'],
        }]);
        const repo = new RdsUserProfileRollupRepository(fakePool(client));
        const out = await repo.listProfilesForRollup('11111111-1111-1111-1111-111111111111');

        const cfg = client.calls.find(c => c.sql.includes('set_config'));
        expect(cfg).toBeDefined();
        expect(cfg!.params[0]).toBe('11111111-1111-1111-1111-111111111111');
        const sel = client.calls.find(c => /FROM repository_profiles/i.test(c.sql))!;
        expect(sel.sql).not.toMatch(/classification\s*=/i);
        expect(sel.sql).not.toMatch(/is_hidden\s*=/i);
        expect(sel.sql).toMatch(/WHERE\s+user_id\s*=\s*\$1/i);
        expect(out).toHaveLength(1);
        expect(out[0].techStack).toEqual(['AWS']);
        expect(client.release).toHaveBeenCalled();
    });
});

describe('RdsUserProfileRollupRepository.upsert', () => {
    it('sets RLS user then upserts ON CONFLICT (user_id) with JSON rollup', async () => {
        const client = fakeClient([]);
        const repo = new RdsUserProfileRollupRepository(fakePool(client));
        await repo.upsert('22222222-2222-2222-2222-222222222222', sampleRollup);

        const cfg = client.calls.find(c => c.sql.includes('set_config'))!;
        expect(cfg.params[0]).toBe('22222222-2222-2222-2222-222222222222');
        const up = client.calls.find(c => /INSERT INTO user_profile_rollup/i.test(c.sql))!;
        expect(up.sql).toMatch(/ON CONFLICT \(user_id\) DO UPDATE/i);
        expect(up.params).toContain(2); // projectRepoCount
        expect(up.params).toContain(3); // totalRepoCount
        expect(up.params.some(p => typeof p === 'string' && p.includes('"version":1'))).toBe(true);
        expect(client.release).toHaveBeenCalled();
    });
});
```

- [ ] **Step 2: Run test, confirm it FAILS**

Run: `cd "$WT" && yarn workspace @bedrock/shared run test --no-cache src/rds/implementations/RdsUserProfileRollupRepository.test.ts`
Expected: FAIL — `Cannot find module './RdsUserProfileRollupRepository.js'`.

- [ ] **Step 3: Create the interface**

`applications/shared/src/rds/interfaces/IUserProfileRollupRepository.ts`:

```ts
/** @format */
import type {
    ProfileAggInput,
    UserProfileRollupResult,
} from '../profile/computeUserProfileRollup.js';

export interface IUserProfileRollupRepository {
    /** ALL of the user's repository_profiles rows (pure fn applies scope). */
    listProfilesForRollup(userId: string): Promise<ProfileAggInput[]>;
    /** Upsert the precomputed rollup for the user (one row per user). */
    upsert(userId: string, result: UserProfileRollupResult): Promise<void>;
}
```

- [ ] **Step 4: Create the impl**

`applications/shared/src/rds/implementations/RdsUserProfileRollupRepository.ts`:

```ts
/**
 * @format
 * RdsUserProfileRollupRepository — reads all of a user's repository_profiles
 * rows (RLS-scoped) and upserts the precomputed user_profile_rollup row.
 * Scope/aggregation lives in computeUserProfileRollup (pure); this class is
 * only data access. Mirrors RepositoryProfileRepository's connect + BEGIN +
 * set_config RLS idiom.
 */
import type { Pool } from 'pg';
import type { IUserProfileRollupRepository } from '../interfaces/IUserProfileRollupRepository.js';
import type {
    ProfileAggInput,
    UserProfileRollupResult,
} from '../profile/computeUserProfileRollup.js';

export class RdsUserProfileRollupRepository implements IUserProfileRollupRepository {
    constructor(private readonly pool: Pool) {}

    async listProfilesForRollup(userId: string): Promise<ProfileAggInput[]> {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [userId]);
            const { rows } = await client.query<ProfileAggInput>(
                `SELECT
                     repo_full_name                                            AS "repoFullName",
                     classification                                            AS "classification",
                     is_hidden                                                 AS "isHidden",
                     extraction_status                                         AS "extractionStatus",
                     NULLIF(extracted->'signals'->>'primary_language', '')     AS "primaryLanguage",
                     COALESCE((extracted->'signals'->>'commit_count')::int, 0) AS "commitCount",
                     extracted->'signals'->>'last_active_at'                   AS "lastActiveAt",
                     COALESCE(extracted->>'domain', '')                        AS "domain",
                     COALESCE(extracted->>'complexity', '')                    AS "complexity",
                     COALESCE(extracted->>'role_inferred', '')                 AS "roleInferred",
                     COALESCE(extracted->'tech_stack', '[]'::jsonb)            AS "techStack"
                   FROM repository_profiles
                  WHERE user_id = $1::uuid`,
                [userId],
            );
            await client.query('COMMIT');
            return rows.map(r => ({
                ...r,
                isHidden:   Boolean(r.isHidden),
                commitCount: Number(r.commitCount ?? 0),
                techStack:  Array.isArray(r.techStack) ? r.techStack : [],
            }));
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw err;
        } finally {
            client.release();
        }
    }

    async upsert(userId: string, result: UserProfileRollupResult): Promise<void> {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [userId]);
            await client.query(
                `INSERT INTO user_profile_rollup (
                     user_id, project_repo_count, total_repo_count,
                     methodology_version, rollup, refreshed_at
                 ) VALUES ($1::uuid, $2, $3, $4, $5::jsonb, now())
                 ON CONFLICT (user_id) DO UPDATE SET
                     project_repo_count  = EXCLUDED.project_repo_count,
                     total_repo_count    = EXCLUDED.total_repo_count,
                     methodology_version = EXCLUDED.methodology_version,
                     rollup              = EXCLUDED.rollup,
                     refreshed_at        = EXCLUDED.refreshed_at`,
                [
                    userId,
                    result.projectRepoCount,
                    result.totalRepoCount,
                    result.methodologyVersion,
                    JSON.stringify(result.rollup),
                ],
            );
            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw err;
        } finally {
            client.release();
        }
    }
}
```

- [ ] **Step 5: Run test, confirm PASS**

Run: `cd "$WT" && yarn workspace @bedrock/shared run test --no-cache src/rds/implementations/RdsUserProfileRollupRepository.test.ts`
Expected: PASS (both suites).

- [ ] **Step 6: Barrel exports**

In `applications/shared/src/rds/index.ts`, after the Task-2 profile exports add:

```ts
export type { IUserProfileRollupRepository } from './interfaces/IUserProfileRollupRepository.js';
export { RdsUserProfileRollupRepository } from './implementations/RdsUserProfileRollupRepository.js';
```

In `applications/shared/src/index.ts`: add `RdsUserProfileRollupRepository` to the value re-export block and `IUserProfileRollupRepository` to the type re-export block (same blocks edited in Task 2).

- [ ] **Step 7: Typecheck + full shared suite + commit**

Run: `cd "$WT" && yarn workspace @bedrock/shared run typecheck && cd "$WT" && yarn workspace @bedrock/shared run test --no-cache`
Expected: PASS; the full shared suite green (no regressions).

```bash
git -C "$WT" add applications/shared/src/rds/interfaces/IUserProfileRollupRepository.ts applications/shared/src/rds/implementations/RdsUserProfileRollupRepository.ts applications/shared/src/rds/implementations/RdsUserProfileRollupRepository.test.ts applications/shared/src/rds/index.ts applications/shared/src/index.ts
git -C "$WT" commit -m "feat(rds): add RdsUserProfileRollupRepository"
```

---

## Task 4: Best-effort refresh wrapper (ingestion)

**Files:**
- Create: `applications/ingestion/src/util/refreshUserProfileRollup.ts`
- Create: `applications/ingestion/src/util/__tests__/refreshUserProfileRollup.test.ts`

(Confirm the ingestion test-dir convention first: `ls applications/ingestion/src/util/` — if existing tests sit beside source rather than in `__tests__/`, follow the existing convention and adjust the test path accordingly.)

`evaluate`-style best-effort: MUST NOT throw. Mirrors the retrieval-probe span/swallow pattern.

- [ ] **Step 1: Write the failing test**

Create `applications/ingestion/src/util/__tests__/refreshUserProfileRollup.test.ts`:

```ts
import { refreshUserProfileRollup } from '../refreshUserProfileRollup.js';
import type { IUserProfileRollupRepository } from '@bedrock/shared';

const rows = [{
    repoFullName: 'o/r', classification: 'project', isHidden: false,
    extractionStatus: 'completed', primaryLanguage: 'TypeScript',
    commitCount: 5, lastActiveAt: null, domain: 'infra',
    complexity: 'simple', roleInferred: 'creator', techStack: ['AWS'],
}];

describe('refreshUserProfileRollup', () => {
    it('reads, computes, and upserts on the happy path', async () => {
        const upsert = jest.fn(async () => {});
        const repo: IUserProfileRollupRepository = {
            listProfilesForRollup: jest.fn(async () => rows as never),
            upsert,
        };
        await expect(refreshUserProfileRollup(repo, 'u1')).resolves.toBeUndefined();
        expect(upsert).toHaveBeenCalledTimes(1);
        const [userId, result] = upsert.mock.calls[0];
        expect(userId).toBe('u1');
        expect(result.projectRepoCount).toBe(1);
    });

    it('NEVER throws when the repository read rejects', async () => {
        const repo: IUserProfileRollupRepository = {
            listProfilesForRollup: jest.fn(async () => { throw new Error('db down'); }),
            upsert: jest.fn(async () => {}),
        };
        await expect(refreshUserProfileRollup(repo, 'u1')).resolves.toBeUndefined();
    });

    it('NEVER throws when upsert rejects', async () => {
        const repo: IUserProfileRollupRepository = {
            listProfilesForRollup: jest.fn(async () => rows as never),
            upsert: jest.fn(async () => { throw new Error('write failed'); }),
        };
        await expect(refreshUserProfileRollup(repo, 'u1')).resolves.toBeUndefined();
    });
});
```

- [ ] **Step 2: Run test, confirm it FAILS**

Run: `cd "$WT" && yarn workspace @bedrock/shared run build && cd "$WT" && yarn workspace @bedrock/ingestion run test --no-cache src/util/__tests__/refreshUserProfileRollup.test.ts`
Expected: FAIL — `Cannot find module '../refreshUserProfileRollup.js'`.

- [ ] **Step 3: Create the wrapper**

`applications/ingestion/src/util/refreshUserProfileRollup.ts`:

```ts
/**
 * @format
 * refreshUserProfileRollup — best-effort per-user rollup refresh.
 *
 * Called at the end of a successful profile extraction. Recomputes the
 * user's ENTIRE rollup (re-reads all their repository_profiles), so it is
 * self-healing and eventually consistent under parallel same-user jobs.
 * MUST NOT throw — a rollup failure must never fail ingestion (same
 * best-effort contract as the retrieval probe).
 */
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { computeUserProfileRollup } from '@bedrock/shared';
import type { IUserProfileRollupRepository } from '@bedrock/shared';

const tracer = trace.getTracer('ingestion-worker');

export async function refreshUserProfileRollup(
    repo: IUserProfileRollupRepository,
    userId: string,
): Promise<void> {
    await tracer.startActiveSpan('ingestion.profile_rollup', async (span) => {
        try {
            const rows   = await repo.listProfilesForRollup(userId);
            const result = computeUserProfileRollup(rows);
            await repo.upsert(userId, result);
            span.setAttributes({
                'profile_rollup.project_repos': result.projectRepoCount,
                'profile_rollup.total_repos':   result.totalRepoCount,
            });
        } catch (err) {
            // Best-effort: a rollup failure MUST NOT break ingestion.
            // Log to the span, swallow, continue.
            span.recordException(err instanceof Error ? err : new Error(String(err)));
            span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
        } finally {
            span.end();
        }
    });
}
```

- [ ] **Step 4: Run test, confirm PASS**

Run: `cd "$WT" && yarn workspace @bedrock/ingestion run test --no-cache src/util/__tests__/refreshUserProfileRollup.test.ts`
Expected: PASS (happy path + both never-throws cases).

- [ ] **Step 5: Typecheck + commit**

Run: `cd "$WT" && yarn workspace @bedrock/ingestion run typecheck`
Expected: PASS.

```bash
git -C "$WT" add applications/ingestion/src/util/refreshUserProfileRollup.ts applications/ingestion/src/util/__tests__/refreshUserProfileRollup.test.ts
git -C "$WT" commit -m "feat(ingestion): add best-effort user profile rollup refresh"
```

---

## Task 5: Wire the refresh into `run-ingestion.ts`

**Files:**
- Modify: `applications/ingestion/src/run-ingestion.ts`

Read the file first. Construct the repository near the other repositories (`const profileRepo = new RepositoryProfileRepository(pgPool);` ~line 190) and call the wrapper right after the profile is marked completed (`await profileRepo.updateStatus(profileId, env.userId, 'completed');` then `profileExtractCallsTotal().inc({ outcome: 'success' });` ~line 243-244), before the `profile_extraction.complete` log. The wrapper is awaited but cannot reject (it swallows internally).

- [ ] **Step 1: Add imports**

Add to the existing imports from `@bedrock/shared` (the import block that already pulls `IngestionPipeline`, etc.): add `RdsUserProfileRollupRepository`. Add a new import line grouped with the other `./util/*` imports:

```ts
import { refreshUserProfileRollup } from './util/refreshUserProfileRollup.js';
```

- [ ] **Step 2: Construct the repository**

Immediately after `const profileRepo      = new RepositoryProfileRepository(pgPool);` add:

```ts
    const rollupRepo       = new RdsUserProfileRollupRepository(pgPool);
```

- [ ] **Step 3: Call the wrapper after profile completed**

Immediately after the line `profileExtractCallsTotal().inc({ outcome: 'success' });` (inside the successful-profile `try`, before the `log.info({ … }, 'profile_extraction.complete');`) add:

```ts
            await refreshUserProfileRollup(rollupRepo, env.userId);
```

- [ ] **Step 4: Build shared, typecheck, full ingestion suite**

Run: `cd "$WT" && yarn workspace @bedrock/shared run build && cd "$WT" && yarn workspace @bedrock/ingestion run typecheck && cd "$WT" && yarn workspace @bedrock/ingestion run test --no-cache`
Expected: typecheck PASS; full ingestion suite green (no regression).

- [ ] **Step 5: Grep-confirm wiring**

Run: `grep -n "RdsUserProfileRollupRepository\|refreshUserProfileRollup\|rollupRepo" applications/ingestion/src/run-ingestion.ts`
Expected: import of `RdsUserProfileRollupRepository`, import of `refreshUserProfileRollup`, `const rollupRepo = …`, and the `await refreshUserProfileRollup(rollupRepo, env.userId);` call — all present.

- [ ] **Step 6: Commit**

```bash
git -C "$WT" add applications/ingestion/src/run-ingestion.ts
git -C "$WT" commit -m "feat(ingestion): refresh user profile rollup after extraction"
```

---

## Task 6: Full regression + finish

- [ ] **Step 1: Authoritative regression (from the worktree)**

Run:
```bash
cd "$WT" && yarn workspace @bedrock/shared run build \
 && cd "$WT" && yarn workspace @bedrock/shared run test --no-cache \
 && cd "$WT" && yarn workspace @bedrock/ingestion run test --no-cache \
 && cd "$WT" && yarn workspace @bedrock/shared run typecheck \
 && cd "$WT" && yarn workspace @bedrock/ingestion run typecheck
```
Expected: shared suite green (incl. the new `computeUserProfileRollup` + `RdsUserProfileRollupRepository` tests), ingestion suite green (incl. `refreshUserProfileRollup`), both typechecks clean.

- [ ] **Step 2: Confirm lineage + clean tree**

Run: `git -C "$WT" log --oneline <base>..HEAD` (6 task commits, in order) and `git -C "$WT" status --porcelain` (no tracked modifications; untracked `applications/shared/dist/` is expected and must NOT be staged).

- [ ] **Step 3: Invoke superpowers:finishing-a-development-branch**

Use the finishing-a-development-branch skill to choose merge / PR / cleanup.

---

## Self-Review

**Spec coverage:**
- Precomputed `user_profile_rollup` table, one row/user, RLS → Task 1.
- Pure aggregation, honest methodology labelling, all documented fields (languages proxy, domains+dominant, complexity, roles, techStackTop, activityArc, totals, classificationCounts, methodology), edge cases (empty, null lang, null lastActiveAt) → Task 2 (code + tests).
- Repo scope `project/!hidden/completed` applied in one testable place (pure fn) → Task 2 `isQualifying`; `classificationCounts` over all rows → Task 2.
- Repository read (all rows, RLS) + upsert (ON CONFLICT user_id, JSONB) → Task 3.
- Contract exported for downstream SPs → Tasks 2 & 3 barrels.
- Best-effort write-time refresh, never fails ingestion, OTel span, self-healing → Task 4 (wrapper + never-throws tests) + Task 5 (wiring after profile `completed`).
- Data-only boundary, no HTTP/UI → no route/page tasks (correct).
- Testing strategy (pure table tests; repository fake-pool; never-throws) → Tasks 2, 3, 4.

**Deliberate deviation from spec (documented):** spec's repository-test bullet implied a SQL `WHERE classification='project' …`; this plan instead returns all rows from the repository and scopes in the pure fn (single source of truth + `classificationCounts` needs all rows). Captured in the File Structure note and Task 3.

**Placeholder scan:** none — every code/SQL step is complete; every command has an expected result; `<base>` in Task 6 Step 2 is the branch base SHA (resolve at execution: `git -C "$WT" merge-base HEAD origin/develop`), not a code placeholder.

**Type consistency:** `ProfileAggInput`, `UserProfileRollup`, `UserProfileRollupResult`, `LanguageStat`, `TechStat`, `ActivityArcEntry`, `IUserProfileRollupRepository` defined in Tasks 2/3 and used identically in Tasks 3/4/5. `computeUserProfileRollup` signature `(rows) → UserProfileRollupResult` consistent across Tasks 2→4. Repository methods `listProfilesForRollup(userId)` / `upsert(userId, result)` consistent Tasks 3→4. `refreshUserProfileRollup(repo, userId)` consistent Tasks 4→5. Migration column names (`project_repo_count`, `total_repo_count`, `methodology_version`, `rollup`, `refreshed_at`) match the repository upsert in Task 3.
