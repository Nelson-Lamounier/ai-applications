# IaC + Code-Comment Detector Strengthening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close ~60% of L1-vs-LLM parity gap by extracting canonical tech mentions from (F1) IaC value strings (ARNs, ECR URIs, K8s annotation values) and (F2) code-language comments + string literals.

**Architecture:** Two independent sub-projects, each shippable as its own PR.
- **F1** extends `iacExtractor` (in `run-tech-extract.ts`) and `parseK8sManifest` with new pure helpers. No new top-level Extractor. Emits `source_layer='iac'` (no DB migration needed).
- **F2** extends `TreeSitterExtractor` with a comment/string-literal scanner. Reuses the prose_safe alias set already loaded for ReadmeParser v2. Emits `source_layer='code-prose'` (DB migration needed to extend the CHECK constraint).

**Tech Stack:** TypeScript (CommonJS workspaces), Yarn Berry, Jest with `@jest/globals`, `yaml` package for YAML parsing, PostgreSQL migrations under `applications/platform-rds-bootstrap/migrations/`. The file `TreeSitterExtractor.ts` is a misnomer — it uses regex, not tree-sitter.

**Branch strategy:** One branch + one PR per sub-project. F2 may merge first or second — they have no code dependencies.

---

## Spec reference

`applications/tech-extractor/specs/2026-05-26-iac-detector-strengthening-design.md` is the authoritative spec. Bucket recount evidence: `applications/tech-extractor/parity/2026-05-26-bucket-recount.{md,csv}`.

**Success criteria (re-measured after BOTH sub-projects land):**
- KBS recall >= 0.85 (currently 0.529)
- TUC recall >= 0.65 (currently 0.266)
- LLM-only canonicals: <= 10 combined across both repos
- FP rate on 30-row spot-check of new iac + code-prose evidence: <= 10%

---

# Sub-project F1 — IaC value scanner

**Branch:** `feat/tech-extractor-iac-value-scanner`
**PR base:** `develop`

## F1 file structure

| File | Responsibility | New / modified |
|------|----------------|----------------|
| `applications/tech-extractor/src/extractors/iac/awsServiceMap.ts` | Single source-of-truth map: AWS service slug -> ontology canonical raw_name. Used by ARN scanner, ECR URI scanner, K8s annotation scanner, and the existing `awsModuleTokens` helper. | NEW |
| `applications/tech-extractor/src/extractors/iac/awsServiceMap.test.ts` | Unit tests for the map. | NEW |
| `applications/tech-extractor/src/extractors/iac/ArnScanner.ts` | Pure: scan an arbitrary string for `arn:aws:<service>:<region>:<account>:<resource>` and emit one RawTechnologyEvidence per distinct service. | NEW |
| `applications/tech-extractor/src/extractors/iac/ArnScanner.test.ts` | Unit tests. | NEW |
| `applications/tech-extractor/src/extractors/iac/EcrUriScanner.ts` | Pure: scan a string for `<12-digit-account>.dkr.ecr.<region>.amazonaws.com/<repo>` and emit one `aws_ecr` evidence row per call. | NEW |
| `applications/tech-extractor/src/extractors/iac/EcrUriScanner.test.ts` | Unit tests. | NEW |
| `applications/tech-extractor/src/extractors/iac/K8sManifestParser.ts` | Add `parseK8sManifestValues` companion: walks ALL docs (not just K8S_KINDS), runs ARN + ECR scanners over leaf string values. Keep `parseK8sManifest` unchanged for back-compat. | MODIFIED |
| `applications/tech-extractor/src/extractors/iac/K8sManifestParser.test.ts` | Add tests for `parseK8sManifestValues`. | MODIFIED |
| `applications/tech-extractor/src/extractors/TreeSitterExtractor.ts` | Optional: validate `awsModuleTokens` slugs against the map. | MODIFIED |
| `applications/tech-extractor/src/run-tech-extract.ts` | In `iacExtractor`, for every `.yaml`/`.yml` file, ALSO call `parseK8sManifestValues` after `parseK8sManifest`. | MODIFIED |
| `applications/tech-extractor/src/__tests__/iac-value-scanner.integration.test.ts` | Integration: frozen-expectation test over a mini chart fixture. | NEW |

## F1 task list

### Task F1-1: AWS service slug map

**Files:**
- Create: `applications/tech-extractor/src/extractors/iac/awsServiceMap.ts`
- Create: `applications/tech-extractor/src/extractors/iac/awsServiceMap.test.ts`

**Behaviour required:** Single source-of-truth map keyed by lowercase AWS service slug, valued by ontology canonical raw_name. Exports `awsCanonicalForSlug(slug) -> string | null` and `AWS_SERVICE_SLUGS: readonly string[]` (the key list).

The map MUST contain at least these slugs (right-side = ontology canonical):

```
acm                  -> aws_acm
apigateway           -> aws_api_gateway
execute-api          -> aws_api_gateway
autoscaling          -> aws_autoscaling
backup               -> aws_backup
bedrock              -> aws_bedrock
ce                   -> aws_cost_explorer
cloudformation       -> aws_cloudformation
cloudfront           -> aws_cloudfront
cloudtrail           -> aws_cloudtrail
cognito-idp          -> aws_cognito
cognito-identity     -> aws_cognito
dynamodb             -> dynamodb
ec2                  -> aws_ec2
ecr                  -> aws_ecr
ecs                  -> aws_ecs
eks                  -> aws_eks
elasticloadbalancing -> aws_elb
firehose             -> aws_firehose
iam                  -> aws_iam
kafka                -> aws_kafka
kinesis              -> aws_kinesis
kms                  -> aws_kms
lambda               -> aws_lambda
logs                 -> aws_cloudwatch
rds                  -> aws_rds
route53              -> aws_route53
s3                   -> aws_s3
secretsmanager       -> aws_secrets_manager
sns                  -> aws_sns
sqs                  -> aws_sqs
ssm                  -> aws_ssm
states               -> aws_step_functions
sts                  -> aws_sts
textract             -> aws_textract
vpc                  -> aws_vpc
waf                  -> aws_waf
wafv2                -> aws_wafv2
```

**Test cases (all must pass):**
- `awsCanonicalForSlug('secretsmanager')` returns `'aws_secrets_manager'`
- `awsCanonicalForSlug('made-up-service')` returns `null`
- `awsCanonicalForSlug('')` returns `null`
- `AWS_SERVICE_SLUGS.length` >= 38

**Implementation shape:**
```ts
const AWS_SERVICE_MAP: ReadonlyMap<string, string> = new Map([ ...rows above... ]);
export const AWS_SERVICE_SLUGS: readonly string[] = [...AWS_SERVICE_MAP.keys()];
export function awsCanonicalForSlug(slug: string): string | null {
    return AWS_SERVICE_MAP.get(slug.toLowerCase()) ?? null;
}
```

**Steps:**
- [ ] Write tests asserting all 38 slugs map correctly + the two null cases + the length assertion
- [ ] Run: `yarn workspace @bedrock/tech-extractor test src/extractors/iac/awsServiceMap.test.ts` — expect FAIL
- [ ] Implement the map + helpers per the shape above
- [ ] Re-run — expect PASS
- [ ] Branch + commit:
    `git checkout -b feat/tech-extractor-iac-value-scanner origin/develop`
    `git add applications/tech-extractor/src/extractors/iac/awsServiceMap.*`
    `git commit -m "feat(tech-extractor): add AWS service-slug to canonical map"`

---

### Task F1-2: ARN scanner

**Files:**
- Create: `applications/tech-extractor/src/extractors/iac/ArnScanner.ts`
- Create: `applications/tech-extractor/src/extractors/iac/ArnScanner.test.ts`

**Behaviour required:**
- Regex matches `arn:aws:<service>:<region?>:<account>:` (service = `[a-z0-9-]+`, region = `[a-z0-9-]*`, account = `\d{0,12}`)
- Maps `<service>` via `awsCanonicalForSlug`; unknown -> drop
- Dedupes by canonical within a single call (one row per service per file)
- Rejects placeholder accounts: `''`, `'000000000000'`, `'123456789012'`
- Each emitted row: `{ raw_name: <canonical>, ecosystem: 'aws-arn', source_layer: 'iac', file_path }`

**Test cases (all must pass):**
1. Single ARN `arn:aws:secretsmanager:eu-west-1:771826808455:secret:foo/bar-Ab1` -> 1 row, raw_name `aws_secrets_manager`
2. Multi-line src with s3 + sns + sqs ARNs -> 3 distinct rows
3. Two s3 ARNs same call -> 1 deduped row
4. Placeholder account `123456789012` -> 0 rows
5. Unknown service slug -> 0 rows
6. Empty / no-ARN input -> 0 rows
7. Region-less ARN (`arn:aws:iam::771826808455:role/x`) -> 1 row `aws_iam`

**Implementation shape:**
```ts
import type { RawTechnologyEvidence } from '../Extractor.js';
import { awsCanonicalForSlug } from './awsServiceMap.js';

const ARN_RE = /arn:aws:([a-z0-9-]+):([a-z0-9-]*):(\d{0,12}):/g;
const PLACEHOLDER_ACCOUNTS = new Set(['', '000000000000', '123456789012']);

export function scanArns(src: string, filePath: string): RawTechnologyEvidence[] {
    const seen = new Set<string>(); const out: RawTechnologyEvidence[] = [];
    let m: RegExpExecArray | null; ARN_RE.lastIndex = 0;
    while ((m = ARN_RE.exec(src)) !== null) {
        const [, slug, , account] = m;
        if (PLACEHOLDER_ACCOUNTS.has(account)) continue;
        const canonical = awsCanonicalForSlug(slug);
        if (!canonical || seen.has(canonical)) continue;
        seen.add(canonical);
        out.push({ raw_name: canonical, ecosystem: 'aws-arn', source_layer: 'iac', file_path: filePath });
    }
    return out;
}
```

**Steps:**
- [ ] Write the 7 tests
- [ ] Run — expect FAIL
- [ ] Implement
- [ ] Run — expect PASS
- [ ] Commit:
    `git add applications/tech-extractor/src/extractors/iac/ArnScanner.*`
    `git commit -m "feat(tech-extractor): add AWS ARN scanner for IaC values"`

---

### Task F1-3: ECR URI scanner

**Files:**
- Create: `applications/tech-extractor/src/extractors/iac/EcrUriScanner.ts`
- Create: `applications/tech-extractor/src/extractors/iac/EcrUriScanner.test.ts`

**Behaviour required:**
- Regex matches `<12-digit>.dkr.ecr.<region>.amazonaws.com/<repo>[:tag|@digest]`
- Emits AT MOST one row per call (per file): `{ raw_name: 'aws_ecr', ecosystem: 'image-uri', source_layer: 'iac', file_path }`
- Rejects placeholder accounts `000000000000` / `123456789012`
- Non-ECR registries (docker.io, ghcr.io, etc.) -> 0 rows

**Test cases:**
1. Single ECR URI -> 1 row
2. Two distinct ECR URIs same call -> 1 row (deduped)
3. Placeholder account -> 0 rows
4. `docker.io/library/nginx:latest` and `ghcr.io/owner/img:tag` -> 0 rows
5. Empty input -> 0 rows

**Implementation shape:**
```ts
const ECR_RE = /\b(\d{12})\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com\/[a-zA-Z0-9_\-./]+/g;
const PLACEHOLDER_ACCOUNTS = new Set(['000000000000', '123456789012']);
export function scanEcrUris(src: string, filePath: string): RawTechnologyEvidence[] {
    let m: RegExpExecArray | null; ECR_RE.lastIndex = 0;
    while ((m = ECR_RE.exec(src)) !== null) {
        if (PLACEHOLDER_ACCOUNTS.has(m[1])) continue;
        return [{ raw_name: 'aws_ecr', ecosystem: 'image-uri', source_layer: 'iac', file_path: filePath }];
    }
    return [];
}
```

**Steps:**
- [ ] Write 5 tests
- [ ] Run — expect FAIL
- [ ] Implement
- [ ] Run — expect PASS
- [ ] Commit:
    `git add applications/tech-extractor/src/extractors/iac/EcrUriScanner.*`
    `git commit -m "feat(tech-extractor): add ECR registry-URI scanner"`

---

### Task F1-4: parseK8sManifestValues (companion to parseK8sManifest)

**Files:**
- Modify: `applications/tech-extractor/src/extractors/iac/K8sManifestParser.ts`
- Modify: `applications/tech-extractor/src/extractors/iac/K8sManifestParser.test.ts`

**Behaviour required:**
- New export `parseK8sManifestValues(src, filePath)`
- Parses ALL YAML docs (no kind filter — unlike parseK8sManifest)
- Walks every leaf string value, joins them with `\n`, feeds the joined string to `scanArns` + `scanEcrUris`
- Returns the union of both scanners' outputs
- Existing `parseK8sManifest` unchanged

**Test cases (append to existing describe block):**
1. ServiceAccount with `eks.amazonaws.com/role-arn: arn:aws:iam::771826808455:role/x` -> includes `aws_iam`
2. ConfigMap (not in K8S_KINDS) with ECR URI in data -> includes `aws_ecr`
3. ExternalSecret (not in K8S_KINDS) with secretsmanager ARN -> includes `aws_secrets_manager`
4. Non-yaml input -> `[]`
5. Multiple s3 ARNs in same file -> deduped to 1 row

**Implementation shape (append to K8sManifestParser.ts; `parseAllDocuments` + `RawTechnologyEvidence` already imported at top):**
```ts
import { scanArns } from './ArnScanner.js';
import { scanEcrUris } from './EcrUriScanner.js';

export function parseK8sManifestValues(src: string, filePath: string): RawTechnologyEvidence[] {
    let docs; try { docs = parseAllDocuments(src); } catch { return []; }
    const allStrings: string[] = [];
    for (const d of docs) {
        let obj: unknown; try { obj = d.toJSON(); } catch { continue; }
        collectStringValues(obj, allStrings);
    }
    if (allStrings.length === 0) return [];
    const joined = allStrings.join('\n');
    return [...scanArns(joined, filePath), ...scanEcrUris(joined, filePath)];
}

function collectStringValues(node: unknown, out: string[]): void {
    if (typeof node === 'string') { out.push(node); return; }
    if (Array.isArray(node)) { node.forEach(n => collectStringValues(n, out)); return; }
    if (node && typeof node === 'object') for (const v of Object.values(node)) collectStringValues(v, out);
}
```

**Steps:**
- [ ] Append 5 tests
- [ ] Run — expect FAIL
- [ ] Implement
- [ ] Run — expect PASS
- [ ] Commit:
    `git add applications/tech-extractor/src/extractors/iac/K8sManifestParser.*`
    `git commit -m "feat(tech-extractor): scan ARN + ECR URIs in all K8s manifest values"`

---

### Task F1-4b: K8s annotation-key allowlist

**Files:** modify `applications/tech-extractor/src/extractors/iac/K8sManifestParser.ts` + .test.ts

**Behaviour required:** When walking annotation maps, if an annotation KEY matches one of the AWS-service-bound prefixes, emit a row for the implied service even if the value contains no ARN. Catches `aws_eks` from a `ServiceAccount` whose only EKS signal is the `eks.amazonaws.com/role-arn` annotation key.

**Key prefix -> canonical map (extend awsServiceMap.ts or inline a small lookup):**
```
eks.amazonaws.com/             -> aws_eks
iam.amazonaws.com/             -> aws_iam
service.beta.kubernetes.io/aws-load-balancer-  -> aws_load_balancer_controller
external-dns.alpha.kubernetes.io/             -> route53 (skip; ambiguous)
```

Keep the list small. ONLY include keys whose prefix is unambiguously a single AWS service. Skip ambiguous ones.

**Implementation strategy:** add a helper `scanK8sAnnotationKeys(docs)` that walks each doc looking for `metadata.annotations` AND `spec.template.metadata.annotations` (for Deployment/StatefulSet/etc.) maps, then matches each key against the prefix table. Call from `parseK8sManifestValues` and merge into the output (dedupe by canonical).

**Test cases (append to K8sManifestParser.test.ts):**
1. ServiceAccount with annotation key `eks.amazonaws.com/role-arn` and any value -> includes `aws_eks`
2. Deployment with `spec.template.metadata.annotations` containing `service.beta.kubernetes.io/aws-load-balancer-name` -> includes `aws_load_balancer_controller`
3. Annotation key that is NOT on the allowlist (e.g., `argocd.argoproj.io/sync-wave`) -> no extra emission
4. Doc with no annotations at all -> no extra emission

**Steps:**
- [ ] Append 4 tests
- [ ] Run — expect FAIL
- [ ] Implement the scanner + merge into `parseK8sManifestValues`
- [ ] Run — expect PASS
- [ ] Update `Task F1-6` integration test's expected union to include `aws_eks` (the comment in that test mentions deferral; remove the `.filter(s => s !== 'aws_eks')` shim and add `'aws_eks'` to the sorted array)
- [ ] Commit:
    `git add applications/tech-extractor/src/extractors/iac/K8sManifestParser.*`
    `git commit -m "feat(tech-extractor): emit canonicals from K8s annotation keys"`

---

### Task F1-5: Wire parseK8sManifestValues into iacExtractor

**Files:** modify `applications/tech-extractor/src/run-tech-extract.ts`

**Step 1:** Update import:
```ts
import { parseK8sManifest, parseK8sManifestValues } from './extractors/iac/K8sManifestParser.js';
```

(Currently only `parseK8sManifest` is imported — find and extend.)

**Step 2:** In the `iacExtractor` function, find:
```ts
else if (rel.endsWith('.yaml') || rel.endsWith('.yml')) out.push(...parseK8sManifest(src, rel));
```

Replace with:
```ts
else if (rel.endsWith('.yaml') || rel.endsWith('.yml')) {
    out.push(...parseK8sManifest(src, rel));
    out.push(...parseK8sManifestValues(src, rel));
}
```

**Steps:**
- [ ] Make both edits above
- [ ] Run `yarn workspace @bedrock/tech-extractor test` — all suites still pass (wiring is additive)
- [ ] Commit:
    `git add applications/tech-extractor/src/run-tech-extract.ts`
    `git commit -m "feat(tech-extractor): wire parseK8sManifestValues into iacExtractor"`

---

### Task F1-6: Integration fixture

**Files:**
- Create: `applications/tech-extractor/src/__tests__/iac-value-scanner.integration.test.ts`
- Create: `applications/tech-extractor/src/__tests__/fixtures/iac-value-chart/sa.yaml`
- Create: `applications/tech-extractor/src/__tests__/fixtures/iac-value-chart/external-secret.yaml`
- Create: `applications/tech-extractor/src/__tests__/fixtures/iac-value-chart/job.yaml`

**Fixture files:**

`sa.yaml`:
```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: app-sa
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::771826808455:role/AppRole
```

`external-secret.yaml`:
```yaml
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata: { name: db }
spec:
  secretStoreRef: { name: aws-ssm, kind: ClusterSecretStore }
  data:
    - secretKey: password
      remoteRef:
        key: arn:aws:secretsmanager:eu-west-1:771826808455:secret:platform/db-AbCdEf
```

`job.yaml`:
```yaml
apiVersion: batch/v1
kind: Job
metadata: { name: migrate }
spec:
  template:
    spec:
      containers:
        - name: migrate
          image: 771826808455.dkr.ecr.eu-west-1.amazonaws.com/tech-extractor:abc-r1
```

**Test (frozen-expectation):**
```ts
import { describe, it, expect } from '@jest/globals';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { parseK8sManifest, parseK8sManifestValues } from '../extractors/iac/K8sManifestParser.js';

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'iac-value-chart');

describe('IaC value scanner integration', () => {
    it('emits expected union of canonicals', async () => {
        const files = ['sa.yaml', 'external-secret.yaml', 'job.yaml'];
        const all: string[] = [];
        for (const f of files) {
            const src = await fs.readFile(path.join(FIXTURE_DIR, f), 'utf-8');
            for (const e of parseK8sManifest(src, f))       all.push(e.raw_name);
            for (const e of parseK8sManifestValues(src, f)) all.push(e.raw_name);
        }
        expect([...new Set(all)].sort()).toEqual(['aws_ecr', 'aws_iam', 'aws_secrets_manager', 'kubernetes']);
    });
});
```

**Steps:**
- [ ] Write three fixture YAMLs
- [ ] Write the integration test
- [ ] Run — expect PASS
- [ ] Commit:
    `git add applications/tech-extractor/src/__tests__/iac-value-scanner.integration.test.ts applications/tech-extractor/src/__tests__/fixtures/iac-value-chart/`
    `git commit -m "test(tech-extractor): integration fixture for IaC value scanner"`

---

### Task F1-7: Optional — validate awsModuleTokens slugs via map

**Skip if time-pressed. Pure refactor, no parity impact.**

**Files:** modify `applications/tech-extractor/src/extractors/TreeSitterExtractor.ts` + .test.ts

**Change:**
```ts
import { awsCanonicalForSlug } from './iac/awsServiceMap.js';

export function awsModuleTokens(module: string): string[] {
    const cdkMatch = /^aws-cdk-lib\/aws-(.+)$/.exec(module);
    if (cdkMatch && awsCanonicalForSlug(cdkMatch[1])) return [cdkMatch[1]];
    const sdkMatch = /^@aws-sdk\/client-(.+)$/.exec(module);
    if (sdkMatch && awsCanonicalForSlug(sdkMatch[1])) return [sdkMatch[1]];
    return [];
}
```

**Add test:**
```ts
it('awsModuleTokens silently drops unknown slugs', () => {
    expect(awsModuleTokens('aws-cdk-lib/aws-made-up-service')).toEqual([]);
    expect(awsModuleTokens('@aws-sdk/client-not-a-real-service')).toEqual([]);
});
```

**Steps:**
- [ ] Add test
- [ ] Implement guard
- [ ] Run all tests — expect PASS
- [ ] Commit:
    `git add applications/tech-extractor/src/extractors/TreeSitterExtractor.*`
    `git commit -m "refactor(tech-extractor): validate awsModuleTokens slugs via awsServiceMap"`

---

### Task F1-8: Push + open PR

**Steps:**
- [ ] Final build + test pass: `yarn workspace @bedrock/tech-extractor test && yarn workspace @bedrock/tech-extractor run build`
- [ ] `git push -u origin feat/tech-extractor-iac-value-scanner`
- [ ] Open PR with the gh command. Title: `feat(tech-extractor): IaC value scanner (F1 of detector strengthening)`. Body summarises: closes (a1) sub-bucket; lists what was added; links to spec at `applications/tech-extractor/specs/2026-05-26-iac-detector-strengthening-design.md`. Test plan checklist must include "after F1 + F2 merge: re-measure parity on both reference repos and update bucket-recount.md".

---

# Sub-project F2 — Code-comment prose scanner

**Branch:** `feat/tech-extractor-code-comment-prose`
**PR base:** `develop`

## F2 file structure

| File | Responsibility | New / modified |
|------|----------------|----------------|
| `applications/platform-rds-bootstrap/migrations/038_evidence_source_layer_code_prose.sql` | Extend `technology_evidence.source_layer` CHECK to include `code-prose`. | NEW |
| `applications/tech-extractor/src/extractors/CommentExtractor.ts` | Pure: given source + language, return prose ranges covering comments + string literals, EXCLUDING import strings. | NEW |
| `applications/tech-extractor/src/extractors/CommentExtractor.test.ts` | Per-language unit tests. | NEW |
| `applications/tech-extractor/src/extractors/iac/ReadmeParser.ts` | Extract `scanProseRanges(ranges, filePath, aliasSet, opts)` so the code-prose path can reuse the prose_safe + length-floor mitigations. Shim existing `parseReadmeProse` to call it. | MODIFIED |
| `applications/tech-extractor/src/extractors/iac/ReadmeParser.test.ts` | Tests for `scanProseRanges`. | MODIFIED |
| `applications/tech-extractor/src/extractors/TreeSitterExtractor.ts` | Accept `proseSafeAliases` in constructor; per file, run `extractProseRanges` -> `scanProseRanges`, re-tag `source_layer='code-prose'`. | MODIFIED |
| `applications/tech-extractor/src/extractors/TreeSitterExtractor.test.ts` | Wiring tests. | MODIFIED |
| `applications/tech-extractor/src/run-tech-extract.ts` | Pass `proseSafeAliases` to `TreeSitterExtractor`. | MODIFIED |

## F2 task list

### Task F2-1a: DB migration

**File:** `applications/platform-rds-bootstrap/migrations/038_evidence_source_layer_code_prose.sql`:

```sql
BEGIN;
ALTER TABLE technology_evidence DROP CONSTRAINT technology_evidence_source_layer_check;
ALTER TABLE technology_evidence ADD CONSTRAINT technology_evidence_source_layer_check
    CHECK (source_layer IN ('syft','treesitter','iac','dockerfile','readme','code-prose'));
COMMENT ON CONSTRAINT technology_evidence_source_layer_check ON technology_evidence IS
    'Adds code-prose for F2 code-comment + string-literal prose scanner (2026-05-26 detector-strengthening spec).';
COMMIT;
```

**Steps:**
- [ ] Branch: `git checkout -b feat/tech-extractor-code-comment-prose origin/develop`
- [ ] Write the migration file
- [ ] Commit:
    `git add applications/platform-rds-bootstrap/migrations/038_evidence_source_layer_code_prose.sql`
    `git commit -m "feat(platform-rds): allow code-prose source_layer (migration 038)"`

### Task F2-1b: Mirror migration in kubernetes-bootstrap chart (separate repo, separate PR)

**Repo:** `/Users/nelsonlamounier/Desktop/portfolio/kubernetes-bootstrap` (branch from `main`, not develop)
**File:** `charts/platform-rds/chart/templates/migration-013-source-layer-code-prose.yaml`

**Pattern:** copy `migration-012-alias-prose-safe.yaml`, rename:
- Job name: `platform-rds-migration-013-source-layer-code-prose`
- `--migration=037_alias_prose_safe.sql` -> `--migration=038_evidence_source_layer_code_prose.sql`
- ArgoCD sync-wave annotation: increment by 1 from 012

**Steps:**
- [ ] Branch in kubernetes-bootstrap from main: `git checkout -b feat/migration-013-source-layer-code-prose main`
- [ ] Copy + adjust the template
- [ ] `helm lint charts/platform-rds/chart` — expect PASS
- [ ] Commit + push + open PR against `main`. PR body notes ordering: must merge BEFORE the ai-applications F2 PR deploys, else F2 INSERT will violate CHECK.

---

### Task F2-2: CommentExtractor (regex-based, per-language)

**Files:**
- Create: `applications/tech-extractor/src/extractors/CommentExtractor.ts`
- Create: `applications/tech-extractor/src/extractors/CommentExtractor.test.ts`

**Behaviour required:**
- Exports `extractProseRanges(src, lang)` returning `ProseRange[]`
- `ProseRange = { text: string; line_start: number; line_end: number }`
- Supported langs: `'typescript' | 'javascript' | 'python' | 'go'`. Anything else -> `[]`
- TS/JS: `//` line comments, `/* ... */` block comments (multi-line OK), single/double/template string literals (excluding import-source strings and `require()` argument strings)
- Python: `#` line comments, `"""..."""` and `'''...'''` triple-quoted multi-line, single/double single-line string literals NOT on `import` / `from` lines
- Go: `//` line comments, `/* */` block comments

**Test cases (CommentExtractor.test.ts):**

TypeScript:
1. `// Use Cognito for auth` -> one range, text `' Use Cognito for auth'`, lines [2,2]
2. Multi-line `/** Wraps AWS Cognito for testing. */` block -> one range with `line_start..line_end` spanning the block, text contains `'Cognito'`
3. `const label = "Secured by AWS Cognito · SOC 2 Type II"` -> at least one range with text containing `'Cognito'`
4. `import {x} from '@aws-sdk/client-s3'; const note = "Uses s3 client";` -> joined output does NOT contain `'@aws-sdk'`, DOES contain `'Uses s3 client'`
5. `const fs = require("node:fs")` -> no range with `'node:fs'`

Python:
6. `# Uses cognito\nx = 1` -> ranges have text `[' Uses cognito']`
7. `def f():\n    """\n    Wraps grafana\n    """\n    pass` -> one range, lines [2,4], text contains `'grafana'`
8. `import boto3\nfrom typing import Optional\nx = "boto3 helper"` -> ranges = `['boto3 helper']`

Go:
9. `// Package main uses prometheus\npackage main\n/* Wraps grafana */` -> ranges (text trimmed) = `['Package main uses prometheus', 'Wraps grafana']`

Unsupported:
10. `extractProseRanges('// hi', 'rust' as any)` -> `[]`

**Implementation:** regex-based per-language extractors. Strategy:
- TS/JS: scan line-only `^\s*\/\/(.*)$` regex per line for line-comments; scan `\/\*([\s\S]*?)\*\//g` over full source for blocks; scan `(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g` for string literals, computing import-string spans via `\b(?:import\b[^'"`]*|require\s*\(\s*)(['"`])([^'"`]+)\1/g` and excluding any literal whose span sits inside an import span.
- Python: `^[^#]*#(.*)$` per line; `"""([\s\S]*?)"""/g` and `'''([\s\S]*?)'''/g` across source; per-line short-string regex `(['"])([^'"\\]+)\1` only on lines NOT matching `^\s*(import|from)\s+`.
- Go: `^\s*\/\/(.*)$` per line; `\/\*([\s\S]*?)\*\//g` across source.

For each range, compute `line_start = src.slice(0, matchIndex).split('\n').length` and `line_end = line_start + matchText.split('\n').length - 1`.

**Steps:**
- [ ] Write all 10 test cases
- [ ] Run — expect FAIL
- [ ] Implement per the strategy above; iterate until green
- [ ] If a test fails on a "//" inside a URL or string, simplify the TS line-comment branch to `^\s*\/\/(.*)$` only — trailing comments are YAGNI
- [ ] Commit:
    `git add applications/tech-extractor/src/extractors/CommentExtractor.*`
    `git commit -m "feat(tech-extractor): regex-based prose range extractor for code files"`

---

### Task F2-3: Refactor ReadmeParser to expose scanProseRanges

**Files:** modify `applications/tech-extractor/src/extractors/iac/ReadmeParser.{ts,test.ts}`

**Behaviour required:**
- New export `scanProseRanges(ranges: Iterable<ProseLineInput>, filePath, aliasSet, opts?) -> RawTechnologyEvidence[]`
- `ProseLineInput = { text: string; line_start: number }`
- Existing `parseReadmeProse(src, filePath, aliasSet, opts?)` keeps the same signature/semantics; internally becomes a shim that splits src on `\n` and calls `scanProseRanges`
- Same dedupe key: `${alias}@${line_start}`
- Same mitigations: minAliasLength (default 4), maxEmissions (default 200), aliasSet.size==0 -> []

**Test cases (append to ReadmeParser.test.ts):**
1. Two ranges with line_starts 42 and 99 -> two evidence rows at those exact lines
2. Range `'grafana grafana grafana'` line 5 -> 1 row at line 5 (dedupe within range)

**Implementation shape:**
```ts
export interface ProseLineInput { readonly text: string; readonly line_start: number; }

export function scanProseRanges(
    ranges: Iterable<ProseLineInput>, filePath: string,
    aliasSet: ReadonlySet<string>, opts: ProseParserOpts = {},
): RawTechnologyEvidence[] {
    const minLen = opts.minAliasLength ?? 4;
    const maxEmissions = opts.maxEmissions ?? 200;
    if (aliasSet.size === 0) return [];
    const out: RawTechnologyEvidence[] = []; const seen = new Set<string>();
    for (const r of ranges) {
        if (!r.text) continue;
        const tokens = r.text.toLowerCase().match(/[a-z0-9_@./-]+/g) ?? [];
        for (const raw of tokens) {
            const tok = raw.replace(/[._/-]+$/g, '');
            if (tok.length < minLen) continue;
            if (!aliasSet.has(tok)) continue;
            const key = `${tok}@${r.line_start}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({ raw_name: tok, ecosystem: 'readme', source_layer: 'readme',
                file_path: filePath, line_start: r.line_start, line_end: r.line_start });
            if (out.length >= maxEmissions) return out;
        }
    }
    return out;
}

export function parseReadmeProse(src, filePath, aliasSet, opts = {}) {
    const ranges = src.split('\n').map((text, i) => ({ text, line_start: i + 1 }));
    return scanProseRanges(ranges, filePath, aliasSet, opts);
}
```

**Steps:**
- [ ] Append both tests
- [ ] Run — expect FAIL
- [ ] Refactor per shape above; ensure ALL existing parseReadmeProse tests still pass (they should — pure refactor)
- [ ] Run — expect PASS for everything
- [ ] Commit:
    `git add applications/tech-extractor/src/extractors/iac/ReadmeParser.*`
    `git commit -m "refactor(tech-extractor): expose scanProseRanges for non-readme reuse"`

---

### Task F2-4: Wire CommentExtractor into TreeSitterExtractor

**Files:**
- Modify: `applications/tech-extractor/src/extractors/TreeSitterExtractor.ts`
- Modify: `applications/tech-extractor/src/extractors/TreeSitterExtractor.test.ts`
- Modify: `applications/tech-extractor/src/run-tech-extract.ts`

**Behaviour required:**
- `TreeSitterExtractor` constructor gains a third positional arg `proseSafeAliases: ReadonlySet<string>`, defaulting to `new Set()`
- For each file: in addition to existing `extractImportsByRegex` + `matchSdkCalls`, IF `proseSafeAliases.size > 0` AND `lang in ('typescript','javascript','python','go')`: run `extractProseRanges` -> `scanProseRanges`, RE-TAG each emitted evidence with `source_layer='code-prose'` and `ecosystem=<lang>`
- `run-tech-extract.ts` passes `proseSafeAliases` (already in scope from the iac extractor's load) into the TreeSitterExtractor constructor

**Test case (append to TreeSitterExtractor.test.ts):**
```ts
it('emits code-prose evidence for prose_safe aliases in comments + string literals', async () => {
    const src = [
        `// uses kubernetes for orchestration`,
        `import { x } from "@aws-sdk/client-s3";`,
        `const note = "Secured by Grafana dashboards";`,
    ].join('\n');
    const ex = new TreeSitterExtractor(
        async () => src, ['src/x.ts'], new Set(['kubernetes', 'grafana']),
    );
    const out = await ex.extract('/tmp');
    const prose = out.filter(e => e.source_layer === 'code-prose');
    expect(prose.map(e => e.raw_name).sort()).toEqual(['grafana', 'kubernetes']);
    expect(prose.some(e => e.raw_name === '@aws-sdk/client-s3')).toBe(false);
});
```

**Implementation shape (TreeSitterExtractor changes):**
```ts
import { extractProseRanges } from './CommentExtractor.js';
import { scanProseRanges } from './iac/ReadmeParser.js';

export class TreeSitterExtractor implements Extractor {
    readonly name = 'treesitter';
    constructor(
        private readonly readFile: (rel: string) => Promise<string>,
        private readonly files: string[],
        private readonly proseSafeAliases: ReadonlySet<string> = new Set(),
    ) {}
    async extract(_rootDir: string): Promise<RawTechnologyEvidence[]> {
        const out: RawTechnologyEvidence[] = [];
        for (const rel of this.files) {
            const ext = rel.slice(rel.lastIndexOf('.'));
            const lang = langForExt(ext);
            if (!lang) continue;
            const src = await this.readFile(rel);
            out.push(...extractImportsByRegex(src, lang, rel));
            out.push(...matchSdkCalls(src, lang, rel));
            if (this.proseSafeAliases.size > 0 &&
                (lang === 'typescript' || lang === 'javascript' || lang === 'python' || lang === 'go')) {
                const ranges = extractProseRanges(src, lang);
                const prose = scanProseRanges(ranges, rel, this.proseSafeAliases);
                for (const e of prose) out.push({ ...e, source_layer: 'code-prose', ecosystem: lang });
            }
        }
        return out;
    }
}
```

**run-tech-extract.ts change:** locate `new TreeSitterExtractor(readFile, files)` in the extractors array, replace with `new TreeSitterExtractor(readFile, files, proseSafeAliases)`. The `proseSafeAliases` variable is already loaded a few lines above.

**Steps:**
- [ ] Append wiring test
- [ ] Implement signature + wiring per shape above
- [ ] Update run-tech-extract.ts call site
- [ ] Run `yarn workspace @bedrock/tech-extractor test` — all suites pass
- [ ] Commit:
    `git add applications/tech-extractor/src/extractors/TreeSitterExtractor.* applications/tech-extractor/src/run-tech-extract.ts`
    `git commit -m "feat(tech-extractor): wire code-prose scanner via TreeSitterExtractor"`

---

### Task F2-5: Push + open PR

**Steps:**
- [ ] Final build + test: `yarn workspace @bedrock/tech-extractor test && yarn workspace @bedrock/tech-extractor run build && yarn workspace @bedrock/shared run build`
- [ ] `git push -u origin feat/tech-extractor-code-comment-prose`
- [ ] Open PR with `gh pr create`. Title: `feat(tech-extractor): code-comment prose scanner (F2 of detector strengthening)`. Body summarises: closes (c2) sub-bucket; adds migration 038; CommentExtractor regex per language; refactor of parseReadmeProse to expose scanProseRanges; wires via TreeSitterExtractor. **Body MUST call out migration ordering: kubernetes-bootstrap migration-013 PostSync hook PR (Task F2-1b) must merge first, else INSERT will violate CHECK constraint at runtime.**

---

# After-merge re-measurement (out-of-band)

This is not part of either PR. It is the validation step that decides what comes next (decommission or F3).

**Steps:**
- [ ] Wait for F1 + F2 PRs to merge into develop and CI to deploy a new tech-extractor image.
- [ ] Wait for kubernetes-bootstrap migration-013 PostSync hook to succeed in dev: `kubectl get jobs -n tech-extractor | grep migration-013`.
- [ ] Re-trigger tech-extract on both reference repos. Template at `/tmp/tech-extract-prose-rerun.yaml` from prior session — replace the image tag with the new commit's image. `kubectl create -f <yaml>`.
- [ ] Query the new parity_runs row for both repos.
- [ ] Confirm success criteria:
    - KBS recall >= 0.85
    - TUC recall >= 0.65
    - LLM-only canonicals <= 10 combined
    - 30-row FP spot-check on new code-prose + iac (aws-arn / image-uri) evidence: <= 10% FP
- [ ] Update `applications/tech-extractor/parity/2026-05-26-bucket-recount.md` with post-F numbers and the new residual distribution.
- [ ] Decide:
    - All criteria met -> decommission PR (one-paragraph BedrockChunkEnricher removal)
    - Narrowly missed -> write F3 plan (YAML-comment prose extraction; closes (a2) sub-bucket)
