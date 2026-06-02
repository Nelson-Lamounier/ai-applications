# DevOps Pillar S3 (lean) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Detect K8s NetworkPolicy + RBAC manifests as distinct DevOps evidence (networking/security), flowing to S1's `devops_networking`/`devops_security_iam` topics.

**Architecture:** 2 new `technology_ontology` canonicals (cloud_networking/cloud_security) + aliases (migration 060); `K8sManifestParser` emits distinct `k8s_networkpolicy`/`k8s_rbac` tokens. S1 category mapping routes them — no S1/admin-api/UI change.

**Tech Stack:** TypeScript, Jest, PostgreSQL. **Branch:** `feat/devops-pillar-s3` off develop. **Spec:** `docs/superpowers/specs/2026-06-02-devops-pillar-s3-design.md`.

---

## Task 1: migration 060 (ontology canonicals + aliases)

**Files:** Create `applications/platform-rds-bootstrap/migrations/060_k8s_rbac_networkpolicy_ontology.sql`

- [ ] **Step 1:** Write the migration (expand-only, idempotent — see spec §A for the exact SQL: 2 technology_ontology rows `k8s_networkpolicy`(cloud_networking)/`k8s_rbac`(cloud_security) `ON CONFLICT (canonical_name) DO NOTHING`; 4 alias rows via `SELECT … JOIN technology_ontology … ON CONFLICT (alias) DO NOTHING`).
- [ ] **Step 2:** Apply to dev (ephemeral psql pod, same as 057). Verify: `SELECT count(*) FROM technology_ontology WHERE canonical_name IN ('k8s_networkpolicy','k8s_rbac')` = 2; `SELECT count(*) FROM technology_aliases WHERE alias IN ('k8s_networkpolicy','k8s_rbac')` = 2.
- [ ] **Step 3:** Commit — `feat(devops): k8s_networkpolicy + k8s_rbac ontology canonicals (migration 060)`

---

## Task 2: K8sManifestParser — distinct NetworkPolicy/RBAC tokens (TDD)

**Files:** Modify `applications/tech-extractor/src/extractors/iac/K8sManifestParser.ts`; Test `applications/tech-extractor/src/extractors/iac/K8sManifestParser.test.ts` (or the nearest existing parser test — find it).

- [ ] **Step 1: Write failing tests:**

```typescript
import { parseK8sManifest } from './K8sManifestParser.js';
const names = (s: string) => parseK8sManifest(s, 'k8s.yaml').map(e => e.raw_name);

it('NetworkPolicy → kubernetes + k8s_networkpolicy', () => {
  const out = names('apiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata:\n  name: deny-all\n');
  expect(out).toContain('kubernetes');
  expect(out).toContain('k8s_networkpolicy');
  expect(out).not.toContain('k8s_rbac');
});
it('RBAC kinds → kubernetes + k8s_rbac (once)', () => {
  const out = names('kind: ClusterRoleBinding\nmetadata:\n  name: x\n');
  expect(out).toContain('kubernetes');
  expect(out.filter(n => n === 'k8s_rbac')).toHaveLength(1);
});
it('Deployment unchanged → kubernetes, no k8s_networkpolicy/k8s_rbac', () => {
  const out = names('kind: Deployment\nspec:\n  template:\n    spec:\n      containers:\n      - image: nginx:1.25\n');
  expect(out).toContain('kubernetes');
  expect(out).toContain('nginx');
  expect(out).not.toContain('k8s_networkpolicy');
  expect(out).not.toContain('k8s_rbac');
});
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement.** In `K8sManifestParser.ts`:
  - Extend the allowlist: `const K8S_KINDS = new Set(['Deployment','StatefulSet','DaemonSet','Job','CronJob','Service','Ingress','Pod','NetworkPolicy','Role','RoleBinding','ClusterRole','ClusterRoleBinding']);`
  - Add an RBAC set: `const RBAC_KINDS = new Set(['Role','RoleBinding','ClusterRole','ClusterRoleBinding']);`
  - In the per-doc loop (after `isK8s = true`), emit the distinct token (dedup across docs via a local Set so one file emits each token once):
    ```typescript
    if (obj.kind === 'NetworkPolicy' && !emitted.has('k8s_networkpolicy')) {
      emitted.add('k8s_networkpolicy');
      out.push({ raw_name: 'k8s_networkpolicy', ecosystem: 'iac', source_layer: 'iac', file_path: filePath });
    }
    if (RBAC_KINDS.has(obj.kind) && !emitted.has('k8s_rbac')) {
      emitted.add('k8s_rbac');
      out.push({ raw_name: 'k8s_rbac', ecosystem: 'iac', source_layer: 'iac', file_path: filePath });
    }
    ```
    (declare `const emitted = new Set<string>();` at the top of `parseK8sManifest`.)
  - Keep the existing `kubernetes` unshift + image collection unchanged.
- [ ] **Step 4:** Run → PASS. Full parser suite green. `npx tsc --noEmit -p applications/tech-extractor` clean.
- [ ] **Step 5:** Commit — `feat(tech-extractor): emit distinct k8s_networkpolicy/k8s_rbac tokens (DevOps networking/security)`

---

## Final
- [ ] `npm test -w applications/tech-extractor` green.
- [ ] Final code-reviewer (focus: distinct tokens resolve via the 060 aliases; Deployment/existing kinds unaffected; dedup; Tier-1).
- [ ] PR (base develop). Body: migration 060 leaves 057–059 for S4 #120; new evidence flows through the existing S1 DevOps section (no S1/UI change); deploy 060 before tech-extractor + re-scan to backfill.
