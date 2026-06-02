# DevOps Pillar S1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface a user's real DevOps/infrastructure work in the Technical workspace by mapping the IaC/cloud/container evidence already in `technology_evidence` to a bounded DevOps topic taxonomy — honestly (Tier-1 "you declared X at file:line").

**Architecture:** A global `devops_topic_mappings` table maps each DevOps topic to `technology_ontology.category` values. admin-api `GET /:slug` joins `technology_evidence ⋈ technology_ontology ⋈ devops_topic_mappings` (RLS-scoped, prose-suppressed, fail-open) → `devopsEvidence`. The Technical workspace renders an evidence-driven "Section C" with Tier-1 copy. No new extraction, no backfill.

**Tech Stack:** PostgreSQL, TypeScript, Hono (admin-api), React + TanStack, Jest/Vitest, pg.

**Spec:** `docs/superpowers/specs/2026-06-02-devops-pillar-s1-design.md`

**Branches:** PR1 `feat/devops-pillar-s1` (ai-applications, off develop — already created). PR2 a new branch off tucaken-app trunk (`main`).

---

## File Structure

- **PR1 (ai-applications):**
  - Create `applications/platform-rds-bootstrap/migrations/056_devops_topic_mappings.sql` — table + 12-row category seed.
- **PR2 (tucaken-app):**
  - Modify `admin-api/src/routes/applications.ts` — serve `devopsEvidence` in `GET /:slug`.
  - Modify `admin-api/__tests__/routes/applications.test.ts` — admin-api test.
  - Modify `src/lib/types/applications.types.ts` — `DevopsTopicEvidence` + `ApplicationDetail.devopsEvidence`.
  - Modify `src/features/applications/stages/workspaces/TechnicalWorkspace.tsx` — Section C.
  - Modify `src/__tests__/features/applications/stage-components.test.tsx` — UI test.

---

## Task 1: migration 056 — `devops_topic_mappings` + seed

**Files:**
- Create: `applications/platform-rds-bootstrap/migrations/056_devops_topic_mappings.sql`

- [ ] **Step 1: Write the migration** (global table, no RLS, idempotent; 12 disjoint category-level topics). Every `mapped_ontology_categories` value MUST be a valid `technology_ontology.category` CHECK enum member:

```sql
-- 056_devops_topic_mappings.sql — DevOps interview-topic taxonomy mapped to the
-- technology_ontology.category buckets that the IaC parsers already populate in
-- technology_evidence. Read-only mapping layer: NO new extraction, NO backfill.
-- Category-level topics are DISJOINT (every technology has exactly one category),
-- so an evidence row maps to at most one topic — no double counting.
-- Tier-1 honesty: display_name says "declared/configured", never competence.
-- Global reference table (no user_id, no RLS), idempotent. Source: maps to the
-- category enum in 034_technology_graph.sql:28-34. Retrieved 2026-06-02.
BEGIN;

CREATE TABLE IF NOT EXISTS devops_topic_mappings (
  canonical_topic_name       TEXT PRIMARY KEY,
  display_name               TEXT NOT NULL,
  topic_group                TEXT NOT NULL,
  mapped_ontology_categories JSONB NOT NULL DEFAULT '[]'::jsonb,
  mapped_canonicals          JSONB NOT NULL DEFAULT '[]'::jsonb,
  jd_signal_keywords         JSONB NOT NULL DEFAULT '[]'::jsonb,
  source                     TEXT NOT NULL,
  as_of                      DATE NOT NULL
);

INSERT INTO devops_topic_mappings
  (canonical_topic_name, display_name, topic_group, mapped_ontology_categories, jd_signal_keywords, source, as_of) VALUES
('devops_iac','Infrastructure as Code','iac','["iac"]'::jsonb,'["terraform","cloudformation","cdk","pulumi","infrastructure as code"]'::jsonb,'technology_ontology.category=iac (034:28-34)','2026-06-02'),
('devops_containers','Containerization','containers','["container_runtime"]'::jsonb,'["docker","container","oci image"]'::jsonb,'technology_ontology.category=container_runtime','2026-06-02'),
('devops_orchestration','Container Orchestration (Kubernetes)','orchestration','["orchestration"]'::jsonb,'["kubernetes","k8s","eks","orchestration","autoscaling"]'::jsonb,'technology_ontology.category=orchestration','2026-06-02'),
('devops_cicd','CI/CD & GitOps','cicd','["ci_cd"]'::jsonb,'["ci/cd","github actions","gitops","argocd","pipeline","deployment"]'::jsonb,'technology_ontology.category=ci_cd','2026-06-02'),
('devops_observability','Observability & Monitoring','observability','["observability"]'::jsonb,'["observability","prometheus","grafana","monitoring","tracing","alerting","slo"]'::jsonb,'technology_ontology.category=observability','2026-06-02'),
('devops_cloud_compute','Cloud Compute','cloud','["cloud_compute"]'::jsonb,'["ec2","ecs","eks","compute","fargate"]'::jsonb,'technology_ontology.category=cloud_compute','2026-06-02'),
('devops_cloud_storage','Cloud Storage','cloud','["cloud_storage"]'::jsonb,'["s3","ebs","backup","object storage"]'::jsonb,'technology_ontology.category=cloud_storage','2026-06-02'),
('devops_cloud_database','Cloud Databases','cloud','["cloud_database"]'::jsonb,'["rds","aurora","dynamodb","managed database"]'::jsonb,'technology_ontology.category=cloud_database','2026-06-02'),
('devops_cloud_serverless','Serverless','cloud','["cloud_serverless"]'::jsonb,'["lambda","step functions","serverless","event-driven"]'::jsonb,'technology_ontology.category=cloud_serverless','2026-06-02'),
('devops_networking','Cloud Networking','networking','["cloud_networking"]'::jsonb,'["vpc","load balancer","route53","cloudfront","ingress","service mesh","dns"]'::jsonb,'technology_ontology.category=cloud_networking','2026-06-02'),
('devops_security_iam','Security & IAM','security','["cloud_security"]'::jsonb,'["iam","least privilege","secrets","kms","encryption","waf","cloudtrail","audit"]'::jsonb,'technology_ontology.category=cloud_security','2026-06-02'),
('devops_messaging','Messaging & Eventing','messaging','["message_broker"]'::jsonb,'["sqs","sns","eventbridge","kafka","queue","pub/sub","event-driven"]'::jsonb,'technology_ontology.category=message_broker','2026-06-02')
ON CONFLICT (canonical_topic_name) DO UPDATE SET
  display_name = EXCLUDED.display_name, topic_group = EXCLUDED.topic_group,
  mapped_ontology_categories = EXCLUDED.mapped_ontology_categories,
  jd_signal_keywords = EXCLUDED.jd_signal_keywords,
  source = EXCLUDED.source, as_of = EXCLUDED.as_of;

COMMIT;
```

- [ ] **Step 2: Apply to dev** via the ephemeral psql pod pattern (same as the DSA migrations). Run:

```bash
cd /Users/nelsonlamounier/Desktop/portfolio/ai-applications
kubectl run psql-056 -n job-strategist --image=postgres:16-alpine --restart=Never \
  --overrides='{"spec":{"containers":[{"name":"psql","image":"postgres:16-alpine","command":["sleep","240"],"envFrom":[{"secretRef":{"name":"platform-rds-credentials"}}]}]}}'
kubectl wait --for=condition=Ready pod/psql-056 -n job-strategist --timeout=90s
cat applications/platform-rds-bootstrap/migrations/056_devops_topic_mappings.sql | \
  kubectl exec -i psql-056 -n job-strategist -- sh -c 'PGPASSWORD=$RDS_PASSWORD psql -h $RDS_HOST -p $RDS_PORT -U $RDS_USER -d $RDS_DB_NAME -v ON_ERROR_STOP=1 -f -'
```
Expected: `BEGIN / CREATE TABLE / INSERT 0 12 / COMMIT`.

- [ ] **Step 3: Verify the seed + that every mapped category is a real ontology category** (no orphan categories):

```bash
kubectl exec -i psql-056 -n job-strategist -- sh -c 'PGPASSWORD=$RDS_PASSWORD psql -h $RDS_HOST -p $RDS_PORT -U $RDS_USER -d $RDS_DB_NAME -tAc "
SELECT count(*) FROM devops_topic_mappings;
SELECT cat FROM devops_topic_mappings, jsonb_array_elements_text(mapped_ontology_categories) cat
 EXCEPT SELECT DISTINCT category FROM technology_ontology;"'
kubectl delete pod psql-056 -n job-strategist --wait=false
```
Expected: first query `12`; second query returns **zero rows** (every mapped category exists in `technology_ontology`).

- [ ] **Step 4: Commit**

```bash
git add applications/platform-rds-bootstrap/migrations/056_devops_topic_mappings.sql
git commit -m "feat(devops): devops_topic_mappings taxonomy (migration 056, category-mapped)"
```

---

## Task 2: admin-api serves `devopsEvidence` (tucaken-app)

**Branch:** create off the tucaken-app trunk: `git checkout main && git pull --ff-only && git checkout -b feat/devops-pillar-s1-ui`

**Files:**
- Modify: `admin-api/src/routes/applications.ts` (the `GET /:slug` handler — add near where other per-user evidence is served; reuse the outer `withUser`-scoped `db` client)
- Test: `admin-api/__tests__/routes/applications.test.ts`

- [ ] **Step 1 (read first):** Open the `GET /:slug` handler in `admin-api/src/routes/applications.ts`. Confirm the outer handler runs inside `withUser(getPool(config), userId, async (db) => { … })` (so `db` is already RLS-scoped: `SET LOCAL app.current_user_id`). Confirm how the response `application` object is assembled. Read `admin-api/src/lib/pg.ts` `withUser`.

- [ ] **Step 2: Write the failing test** (mirror the existing GET /:slug test harness in `applications.test.ts`; add a 6th `db.query` mock for the devops aggregation):

```typescript
it('serves devopsEvidence aggregated by topic', async () => {
  // ... existing GET /:slug setup; make the devops query mock return:
  // rows: [{ canonical_topic_name: 'devops_iac', display_name: 'Infrastructure as Code',
  //          topic_group: 'iac', artifact_count: 2,
  //          samples: [{ repo: 'o/r', file: 'main.tf', line: 3, rawName: 'terraform' }] }]
  const res = await app.request('/applications/app-1', { headers: authHeaders });
  const body = await res.json();
  expect(body.application.devopsEvidence).toEqual([
    { canonicalTopicName: 'devops_iac', displayName: 'Infrastructure as Code',
      topicGroup: 'iac', artifactCount: 2,
      samples: [{ repo: 'o/r', file: 'main.tf', line: 3, rawName: 'terraform' }] },
  ]);
});

it('fail-open: devops query throws → field omitted, still 200', async () => {
  // make the devops query mock reject
  const res = await app.request('/applications/app-1', { headers: authHeaders });
  expect(res.status).toBe(200);
  expect((await res.json()).application.devopsEvidence).toBeUndefined();
});
```

- [ ] **Step 3: Run, verify fail.** Run: `cd admin-api && npm test -- applications.test` → FAIL.

- [ ] **Step 4: Implement** — inside the `GET /:slug` handler, after the existing evidence/research assembly and BEFORE building the response object, using the outer RLS-scoped `db`:

```typescript
// DevOps real-work evidence: technology_evidence ⋈ technology_ontology ⋈ devops_topic_mappings.
// Reuses the outer withUser-scoped db client (RLS). Prose-suppressed. Fail-open.
let devopsEvidence: Array<{
  canonicalTopicName: string; displayName: string; topicGroup: string;
  artifactCount: number; samples: { repo: string; file: string; line: number; rawName: string }[];
}> | undefined;
try {
  const { rows } = await db.query<{
    canonical_topic_name: string; display_name: string; topic_group: string;
    artifact_count: number; samples: { repo: string; file: string; line: number; rawName: string }[];
  }>(
    `SELECT m.canonical_topic_name, m.display_name, m.topic_group,
            COUNT(*)::int AS artifact_count,
            (ARRAY_AGG(json_build_object('repo', e.repo_full_name, 'file', e.file_path,
                                         'line', e.line_start, 'rawName', e.raw_name)
                       ORDER BY e.confidence DESC NULLS LAST))[1:3] AS samples
       FROM technology_evidence e
       JOIN technology_ontology o ON o.id = e.technology_id
       JOIN devops_topic_mappings m
         ON o.category IN (SELECT jsonb_array_elements_text(m.mapped_ontology_categories))
      WHERE e.user_id = current_setting('app.current_user_id')::uuid
        AND e.source_layer NOT IN ('readme','code-prose')
        AND e.file_path !~* '\\.(md|markdown)$'
      GROUP BY m.canonical_topic_name, m.display_name, m.topic_group
      ORDER BY m.topic_group, m.canonical_topic_name`,
  );
  devopsEvidence = rows.map((r) => ({
    canonicalTopicName: r.canonical_topic_name, displayName: r.display_name,
    topicGroup: r.topic_group, artifactCount: Number(r.artifact_count), samples: r.samples ?? [],
  }));
} catch (err) {
  console.error('[devops] evidence aggregation failed (non-fatal)', (err as Error).message);
}
```
Then add `devopsEvidence,` to the returned `application` object (omit-when-undefined via spread if that's the file's convention: `...(devopsEvidence !== undefined ? { devopsEvidence } : {})`).

- [ ] **Step 5: Run, verify pass.** Run: `cd admin-api && npm test -- applications.test` → PASS.

- [ ] **Step 6: Commit**

```bash
git add admin-api/src/routes/applications.ts admin-api/__tests__/routes/applications.test.ts
git commit -m "feat(admin-api): serve devopsEvidence (technology_evidence ⋈ devops_topic_mappings, RLS, prose-suppressed)"
```

---

## Task 3: UI types + Technical Section C (tucaken-app)

**Files:**
- Modify: `src/lib/types/applications.types.ts`
- Modify: `src/features/applications/stages/workspaces/TechnicalWorkspace.tsx`
- Test: `src/__tests__/features/applications/stage-components.test.tsx`

- [ ] **Step 1: Add UI types** in `applications.types.ts` (near the existing `DsaTopicCalibration` / `technicalRoundType`):

```typescript
export interface DevopsTopicEvidence {
  readonly canonicalTopicName: string;
  readonly displayName: string;
  readonly topicGroup: string;
  readonly artifactCount: number;
  readonly samples: { repo: string; file: string; line: number; rawName: string }[];
}
// on ApplicationDetail:
  readonly devopsEvidence?: DevopsTopicEvidence[];
```

- [ ] **Step 2: Write the failing test** (extend `stage-components.test.tsx`):

```typescript
it('Technical Section C renders DevOps evidence with Tier-1 copy + file:line', () => {
  const detail = makeDetail({
    devopsEvidence: [{
      canonicalTopicName: 'devops_iac', displayName: 'Infrastructure as Code',
      topicGroup: 'iac', artifactCount: 2,
      samples: [{ repo: 'o/r', file: 'main.tf', line: 3, rawName: 'terraform' }],
    }],
  });
  render(<TechnicalWorkspace detail={detail} />);
  expect(screen.getByText(/DevOps \/ Infrastructure/i)).toBeInTheDocument();
  expect(screen.getByText(/Infrastructure as Code/)).toBeInTheDocument();
  expect(screen.getByText(/o\/r\/main\.tf:3/)).toBeInTheDocument();
  // Tier-1: must NOT claim competence
  expect(screen.queryByText(/expert|mastered|you know/i)).not.toBeInTheDocument();
});

it('Section C hidden when no devopsEvidence', () => {
  render(<TechnicalWorkspace detail={makeDetail({ devopsEvidence: [] })} />);
  expect(screen.queryByText(/DevOps \/ Infrastructure/i)).not.toBeInTheDocument();
});
```
(Adapt `makeDetail`/render to the file's existing helpers.)

- [ ] **Step 3: Run, verify fail.** Run: `npm test -- stage-components` → FAIL.

- [ ] **Step 4: Implement Section C** in `TechnicalWorkspace.tsx` (after Section B). Evidence-driven gate; group by `topicGroup`; Tier-1 copy + GitHub link:

```tsx
{/* Section C — DevOps / Infrastructure (evidence-driven; Tier-1 'you declared X'; no competence claim) */}
{detail.devopsEvidence && detail.devopsEvidence.length > 0 && (
  <section className="space-y-3">
    <SectionHeading>DevOps / Infrastructure</SectionHeading>
    <Card className="border-blue-200 p-4 text-sm text-zinc-600 dark:border-blue-500/20 dark:text-zinc-400">
      The infrastructure artifacts your repos declare, with receipts — what you can speak to,
      not a competence score. Depth assessment is coming.
    </Card>
    <div className="space-y-3">
      {detail.devopsEvidence.map(topic => {
        const s = topic.samples[0]
        const ghUrl = s ? `https://github.com/${s.repo}/blob/HEAD/${s.file}#L${s.line}` : undefined
        return (
          <Card key={topic.canonicalTopicName} className="space-y-2 p-4">
            <div className="flex items-center gap-2">
              <span className="inline-flex rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700 ring-1 ring-inset ring-blue-600/20 dark:bg-blue-500/10 dark:text-blue-300 dark:ring-blue-500/20">
                {topic.topicGroup}
              </span>
              <h4 className="text-sm font-semibold text-zinc-900 dark:text-white">{topic.displayName}</h4>
            </div>
            {s && (
              <p className="text-xs text-zinc-600 dark:text-zinc-400">
                You declared{' '}
                {ghUrl ? (
                  <a href={ghUrl} target="_blank" rel="noopener noreferrer"
                     className="inline-flex items-center gap-0.5 font-mono font-medium underline underline-offset-2 hover:text-blue-600">
                    {s.repo}/{s.file}:{s.line} <ExternalLink className="size-3" aria-hidden />
                  </a>
                ) : (
                  <span className="font-mono">{s.repo}/{s.file}:{s.line}</span>
                )}{' '}
                (<span className="font-mono">{s.rawName}</span>)
                {topic.artifactCount > 1 && (
                  <span className="text-zinc-400 dark:text-zinc-500"> · {topic.artifactCount} artifacts</span>
                )}
              </p>
            )}
          </Card>
        )
      })}
    </div>
  </section>
)}
```
Reuse the existing `SectionHeading`, `Card`, and `ExternalLink` imports already in the file (confirm they exist; the DSA Section B uses them).

- [ ] **Step 5: Run, verify pass.** Run: `npm test -- stage-components` → PASS. Typecheck clean (`npm run build` or `tsc --noEmit`).

- [ ] **Step 6: Commit**

```bash
git add src/lib/types/applications.types.ts src/features/applications/stages/workspaces/TechnicalWorkspace.tsx src/__tests__/features/applications/stage-components.test.tsx
git commit -m "feat(ui): Technical Section C — DevOps/Infrastructure evidence (Tier-1, evidence-driven)"
```

---

## Final
- [ ] PR1: full `npm test -w applications/...` unaffected (migration only); push `feat/devops-pillar-s1`, open PR (base develop).
- [ ] PR2: full UI + admin-api suites green; push `feat/devops-pillar-s1-ui`, open PR (base main; depends on PR1 applied).
- [ ] Dispatch final code-reviewer (focus: Tier-1 display language — no competence claims; RLS on the join; prose suppression; fail-open; category mapping disjoint/no double-count).
- [ ] superpowers:finishing-a-development-branch. PR bodies: note no new extraction/backfill; deploy migration 056 before admin-api; S1 is evidence-driven JD-agnostic (S2 adds calibration later).

## Notes / out of scope (S1)
- Tier-2 competence (depth markers) — needs extractor work — future spec.
- `mapped_canonicals` is seeded empty (fine-grain splits later without a migration).
- JD calibration (S2), round_type (S5), AI pillar (S4).
