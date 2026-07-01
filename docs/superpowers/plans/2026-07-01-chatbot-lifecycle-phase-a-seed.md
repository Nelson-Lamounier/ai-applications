# Chatbot Lifecycle — Phase A (seed now) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the portfolio chatbot answer the Kubernetes-cluster question with the current EKS reality *today*, by adding a `lifecycle` embedding chunk_type, seeding one lifecycle chunk for the owner's platform repo, purging the stale kubeadm chunks, and teaching the prompt to frame history as history.

**Architecture:** A DB migration extends the profile-embeddings `chunk_type` CHECK; a one-off seed embeds a single migration-fact chunk (Titan, generated locally) into `repository_profile_embeddings` for the portfolio owner; a purge removes the retired kubeadm/Calico/golden-AMI rows from `document_embeddings`; a one-line temporal rule is added to the chatbot system prompt. All live-DB steps run through the `admin-api` pod → PgBouncer, the read-only-verified access path.

**Tech Stack:** Postgres + pgvector (RDS via PgBouncer), Amazon Titan `amazon.titan-embed-text-v2:0` (1024-dim), TypeScript system-prompt constant, `kubectl exec`, AWS CLI (dev-account, eu-west-1).

## Global Constraints

- **Portfolio owner user_id (seed + purge target):** `1d4c645a-447e-4b5b-924d-19a3c75a84db` (this is `PORTFOLIO_OWNER_USER_ID` on `bedrock-dev-chatbot-public`; the chatbot only retrieves this user's rows). NOT the `role='admin'` user `03a37142-…`.
- **kubernetes-bootstrap profile_id (seed target):** `0c4342ef-6d23-4385-9f4c-19b878b7b05d`.
- **Embedding model:** `amazon.titan-embed-text-v2:0`, `{ dimensions: 1024, normalize: true }`, vector length 1024.
- **DB access path:** `kubectl --context eks-dev -n admin-api exec` into an `admin-api` pod; connect with the pod's `PG_*` env to `pgbouncer.platform.svc`. RLS is enforced — every write wraps `SELECT set_config('app.current_user_id', '<user_id>', true)` in the same transaction.
- **Embedding generation:** produced LOCALLY with the `dev-account` AWS profile (`aws bedrock-runtime invoke-model`); the `admin-api` pod has no Bedrock SDK.
- **Env for AWS/kubectl:** `export PATH="$HOME/.nvm/versions/node/v22.22.3/bin:/opt/homebrew/bin:/usr/local/bin:$PATH" AWS_PROFILE=dev-account AWS_REGION=eu-west-1 KUBECONFIG=$HOME/.kube/config`.
- **Migration numbering:** next free is `104`; migrations are idempotent, wrapped `BEGIN; … COMMIT;`, header comment `-- NNN_name.sql -- desc. Idempotent.`.
- **Layer 1 dependency:** Task 4 (prompt) edits `applications/shared/src/chatbot/system-prompt.ts`, which Layer 1 (`fix/chatbot-data-driven-prompt`) also edits. The live chatbot will not answer EKS until **Layer 1 is merged and deployed** — Phase A's data changes are necessary but not sufficient without it. Rebase this branch onto Layer 1 (or merge Layer 1 to develop first) before Task 4.
- English (UK) spelling; commit messages carry NO `Co-Authored-By` trailer.

---

### Task 1: Migration 104 — add `lifecycle` chunk_type

**Files:**
- Create: `applications/platform-rds-bootstrap/migrations/104_add_profile_lifecycle_chunk_type.sql`

**Interfaces:**
- Produces: the `repository_profile_embeddings.chunk_type` CHECK now accepts `'lifecycle'` (consumed by Task 2's insert and Phase C's `embedProfile`).

- [ ] **Step 1: Write the migration**

Create `applications/platform-rds-bootstrap/migrations/104_add_profile_lifecycle_chunk_type.sql`:

```sql
-- 104_add_profile_lifecycle_chunk_type.sql -- allow 'lifecycle' profile chunks. Idempotent.
--
-- Adds a fourth profile-embedding chunk_type, 'lifecycle', carrying a repo's
-- migration/timeline fact (e.g. "currently EKS, migrated from kubeadm") so the
-- chatbot can answer temporally. The CHECK in 014 is an inline column constraint
-- named repository_profile_embeddings_chunk_type_check; drop and re-add it.

BEGIN;

ALTER TABLE repository_profile_embeddings
  DROP CONSTRAINT IF EXISTS repository_profile_embeddings_chunk_type_check;

ALTER TABLE repository_profile_embeddings
  ADD CONSTRAINT repository_profile_embeddings_chunk_type_check
  CHECK (chunk_type IN ('one_liner', 'description', 'highlight', 'lifecycle'));

COMMIT;
```

- [ ] **Step 2: Apply to the dev DB and verify the constraint**

Run (single line; substitutes the SQL into a pod psql-via-node call):

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.3/bin:/opt/homebrew/bin:/usr/local/bin:$PATH" AWS_PROFILE=dev-account AWS_REGION=eu-west-1 KUBECONFIG=$HOME/.kube/config
POD=$(kubectl --context eks-dev -n admin-api get pods -o name | head -1); POD=${POD#pod/}
MIG=applications/platform-rds-bootstrap/migrations/104_add_profile_lifecycle_chunk_type.sql
node -e "const{Pool}=require('/app/node_modules/pg');" 2>/dev/null # noop guard
cat "$MIG" | kubectl --context eks-dev -n admin-api exec -i "$POD" -- sh -c 'cat > /tmp/104.sql && NODE_PATH=/app/node_modules node -e "const fs=require(\"fs\");const{Pool}=require(\"pg\");(async()=>{const p=new Pool({host:process.env.PG_HOST,port:+process.env.PG_PORT,database:process.env.PG_DATABASE,user:process.env.PG_USER,password:process.env.PG_PASSWORD});await p.query(fs.readFileSync(\"/tmp/104.sql\",\"utf8\"));const c=await p.query(\"select pg_get_constraintdef(oid) def from pg_constraint where conname=\x27repository_profile_embeddings_chunk_type_check\x27\");console.log(c.rows[0].def);await p.end();})().catch(e=>{console.log(\"ERR\",e.message);process.exit(1)})"'
```

Expected output: `CHECK ((chunk_type = ANY (ARRAY['one_liner'::text, 'description'::text, 'highlight'::text, 'lifecycle'::text])))`

- [ ] **Step 3: Commit**

```bash
git add applications/platform-rds-bootstrap/migrations/104_add_profile_lifecycle_chunk_type.sql
git commit -m "feat(db): add 'lifecycle' profile-embeddings chunk_type (migration 104)"
```

---

### Task 2: Seed the lifecycle chunk for the owner's kubernetes-bootstrap profile

**Files:**
- Create: `scripts/seed/lifecycle-chunk.md` (a committed, reproducible runbook of the exact commands — this is a one-off live-ops seed, recorded so it is auditable and repeatable).

**Interfaces:**
- Consumes: migration 104 (Task 1). Owner `1d4c645a-…`, profile `0c4342ef-…`.
- Produces: one `repository_profile_embeddings` row with `chunk_type='lifecycle'`, retrievable by the chatbot; carries `metadata = {"seeded":"phase-a"}` so Phase C can find and replace it.

- [ ] **Step 1: Define the lifecycle content (grounded in verified live facts)**

Content string (verified: EKS 1.34, Karpenter, VPC CNI, migrated ~2026-05; ArgoCD + Traefik retained):

```
Kubernetes platform lifecycle: the cluster currently runs on Amazon EKS (Kubernetes 1.34, Karpenter-provisioned nodes, VPC CNI). It was migrated in 2026-05 from a self-managed kubeadm cluster; ArgoCD GitOps and Traefik ingress carried across the migration.
```

- [ ] **Step 2: Generate the embedding locally (Titan) and compute the content hash**

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.3/bin:/opt/homebrew/bin:/usr/local/bin:$PATH" AWS_PROFILE=dev-account AWS_REGION=eu-west-1
CONTENT='Kubernetes platform lifecycle: the cluster currently runs on Amazon EKS (Kubernetes 1.34, Karpenter-provisioned nodes, VPC CNI). It was migrated in 2026-05 from a self-managed kubeadm cluster; ArgoCD GitOps and Traefik ingress carried across the migration.'
node -e "const b=Buffer.from(JSON.stringify({inputText:process.env.C,dimensions:1024,normalize:true})).toString('base64');process.stdout.write(b)" C="$CONTENT" > /tmp/titan-body.b64
aws bedrock-runtime invoke-model --model-id amazon.titan-embed-text-v2:0 --content-type application/json --accept application/json --body "$(cat /tmp/titan-body.b64)" /tmp/titan-emb.json >/dev/null
node -e "const fs=require('crypto');const c=process.env.C;const emb=JSON.parse(require('fs').readFileSync('/tmp/titan-emb.json','utf8')).embedding;if(emb.length!==1024)throw new Error('dim '+emb.length);const hash=fs.createHash('sha256').update(c,'utf8').digest('hex');require('fs').writeFileSync('/tmp/seed.json',JSON.stringify({content:c,contentHash:hash,embedding:emb}));console.log('dim=',emb.length,'hash=',hash)" C="$CONTENT"
```

Expected: `dim= 1024 hash=<64-hex>`. Note: the content has no PII, so `sha256(content)` equals the pipeline's `sha256(scrubbed content)` — Phase C will match.

- [ ] **Step 3: Insert the row via the admin-api pod under the owner's RLS context**

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.3/bin:/opt/homebrew/bin:/usr/local/bin:$PATH" AWS_PROFILE=dev-account AWS_REGION=eu-west-1 KUBECONFIG=$HOME/.kube/config
POD=$(kubectl --context eks-dev -n admin-api get pods -o name | head -1); POD=${POD#pod/}
cat /tmp/seed.json | kubectl --context eks-dev -n admin-api exec -i "$POD" -- sh -c 'cat > /tmp/seed.json && NODE_PATH=/app/node_modules node -e "
const fs=require(\"fs\");const{Pool}=require(\"pg\");
const s=JSON.parse(fs.readFileSync(\"/tmp/seed.json\",\"utf8\"));
const USER=\"1d4c645a-447e-4b5b-924d-19a3c75a84db\";const PROFILE=\"0c4342ef-6d23-4385-9f4c-19b878b7b05d\";
(async()=>{const p=new Pool({host:process.env.PG_HOST,port:+process.env.PG_PORT,database:process.env.PG_DATABASE,user:process.env.PG_USER,password:process.env.PG_PASSWORD});
const c=await p.connect();try{await c.query(\"BEGIN\");await c.query(\"SELECT set_config(\x27app.current_user_id\x27,\$1,true)\",[USER]);
await c.query(\"INSERT INTO repository_profile_embeddings (user_id,profile_id,chunk_type,content,content_hash,embedding,metadata) VALUES (\$1::uuid,\$2::uuid,\x27lifecycle\x27,\$3,\$4,\$5::vector,\x27{\\\"seeded\\\":\\\"phase-a\\\"}\x27::jsonb) ON CONFLICT (profile_id,chunk_type,content_hash) DO UPDATE SET embedding=EXCLUDED.embedding,last_synced_at=now()\",[USER,PROFILE,s.content,s.contentHash,\"[\"+s.embedding.join(\",\")+\"]\"]);
await c.query(\"COMMIT\");console.log(\"seeded ok\");}catch(e){await c.query(\"ROLLBACK\");console.log(\"ERR\",e.message);process.exit(1)}finally{c.release();await p.end();}})()"'
```

Expected: `seeded ok`

- [ ] **Step 4: Verify the row is present and retrievable**

```bash
POD=$(kubectl --context eks-dev -n admin-api get pods -o name | head -1); POD=${POD#pod/}
kubectl --context eks-dev -n admin-api exec "$POD" -- sh -c 'NODE_PATH=/app/node_modules node -e "const{Pool}=require(\"pg\");(async()=>{const p=new Pool({host:process.env.PG_HOST,port:+process.env.PG_PORT,database:process.env.PG_DATABASE,user:process.env.PG_USER,password:process.env.PG_PASSWORD});const r=await p.query(\"select chunk_type,left(content,60) c,metadata from repository_profile_embeddings where profile_id=\x270c4342ef-6d23-4385-9f4c-19b878b7b05d\x27 and chunk_type=\x27lifecycle\x27\");console.log(JSON.stringify(r.rows,null,2));await p.end();})()"'
```

Expected: one row, `chunk_type: "lifecycle"`, `metadata: {"seeded":"phase-a"}`.

- [ ] **Step 5: Record the runbook and commit**

Write `scripts/seed/lifecycle-chunk.md` capturing Steps 1–4 verbatim (content string, commands, expected outputs, the target ids) so the seed is auditable/repeatable. Commit:

```bash
git add scripts/seed/lifecycle-chunk.md
git commit -m "docs(seed): record Phase A lifecycle-chunk seed runbook"
```

---

### Task 3: Retrieval check — does EKS/lifecycle now win? (NON-destructive; no delete)

The original purge is **removed**: it would delete only 43 rows (27 sm-a/ + 8 + 8
resume) of ~428 kubeadm chunks — tiny and ineffective — the pipeline does not
auto-prune (`RepoIngestionOrchestrator.ts:256`), and deleting history contradicts
the lifecycle-keeps-history principle. Instead, verify whether the seeded
lifecycle chunk + Layer 1 + temporal prompt already make EKS rank first. Delete
nothing. If EKS does not win, STOP and report options for the owner to choose —
do not delete on your own.

**Files:** none (read-only).

**Interfaces:**
- Consumes: the seeded lifecycle chunk (Task 2), owner `1d4c645a-…`.

- [ ] **Step 1: Retrieval probe for the cluster question (read-only)**

Query the cluster question through the profile + chunk retrieval for the owner
and inspect the top-ranked passages. Run in the pod (read-only), embedding the
query locally first (Titan, as in Task 2 Step 2) and passing the vector in:

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.3/bin:/opt/homebrew/bin:/usr/local/bin:$PATH" AWS_PROFILE=dev-account AWS_REGION=eu-west-1 KUBECONFIG=$HOME/.kube/config
Q='How is your Kubernetes cluster set up?'
node -e "const b=Buffer.from(JSON.stringify({inputText:process.env.Q,dimensions:1024,normalize:true})).toString('base64');process.stdout.write(b)" Q="$Q" > /tmp/q.b64
aws bedrock-runtime invoke-model --model-id amazon.titan-embed-text-v2:0 --content-type application/json --accept application/json --body "$(cat /tmp/q.b64)" /tmp/q-emb.json >/dev/null
node -e "require('fs').writeFileSync('/tmp/qvec.txt','['+JSON.parse(require('fs').readFileSync('/tmp/q-emb.json','utf8')).embedding.join(',')+']')"
POD=$(kubectl --context eks-dev -n admin-api get pods -o name | head -1); POD=${POD#pod/}
cat /tmp/qvec.txt | kubectl --context eks-dev -n admin-api exec -i "$POD" -- sh -c 'cat > /tmp/qvec.txt && NODE_PATH=/app/node_modules node -e "const fs=require(\"fs\");const{Pool}=require(\"pg\");const v=fs.readFileSync(\"/tmp/qvec.txt\",\"utf8\").trim();const USER=\"1d4c645a-447e-4b5b-924d-19a3c75a84db\";(async()=>{const p=new Pool({host:process.env.PG_HOST,port:+process.env.PG_PORT,database:process.env.PG_DATABASE,user:process.env.PG_USER,password:process.env.PG_PASSWORD});await p.query(\"select set_config(\x27app.current_user_id\x27,\$1,true)\",[USER]);const prof=await p.query(\"select \x27profile\x27 src, chunk_type, left(content,90) c, 1-(embedding<=>\$1::vector) sim from repository_profile_embeddings where user_id=\$2::uuid order by embedding<=>\$1::vector limit 5\",[v,USER]);const chunk=await p.query(\"select \x27chunk\x27 src, file_path, left(content,90) c, 1-(embedding<=>\$1::vector) sim from document_embeddings where user_id=\$2::uuid order by embedding<=>\$1::vector limit 5\",[v,USER]);console.log(JSON.stringify({profile:prof.rows,chunk:chunk.rows},null,2));await p.end();})()"'
```

Expected: the seeded `lifecycle` profile chunk appears at/near the top of the
profile results, and the top chunk-layer results are EKS/README, not `sm-a/`
kubeadm code.

- [ ] **Step 2: Decide — pass or stop**

If EKS/lifecycle ranks at the top of the profile layer (it is heavily weighted
in the final RRF merge): Phase A data work is **done** — record the top-5 and
proceed to Task 4. Do NOT delete anything.

If kubeadm chunks still dominate: **STOP and report** to the owner with the
ranked evidence and options (e.g. raise the profile-layer weight, or a narrowly
targeted removal they explicitly approve). Do not mutate data without approval.

---

### Task 4: Temporal-framing prompt rule (depends on Layer 1)

**Files:**
- Modify: `applications/shared/src/chatbot/system-prompt.ts` (rebased on Layer 1's version).
- Modify: `applications/shared/src/chatbot/system-prompt.test.ts` (the Layer 1 guard test).

**Interfaces:**
- Consumes: Layer 1's data-driven prompt as the base.
- Produces: a temporal instruction the model follows when lifecycle passages are present.

- [ ] **Step 1: Confirm Layer 1 is the base**

Run: `git merge-base --is-ancestor <layer1-head> HEAD && echo OK || echo "REBASE NEEDED"`
Expected: `OK`. If `REBASE NEEDED`, rebase this branch onto the merged Layer 1 before continuing (do not duplicate Layer 1's prompt edits by hand).

- [ ] **Step 2: Add a failing guard-test assertion for the temporal rule**

In `system-prompt.test.ts`, add to the "retains behavioural guardrails" describe block:

```typescript
    it('teaches temporal framing for lifecycle/migration context', () => {
        expect(CHATBOT_SYSTEM_PROMPT).toMatch(/current state[\s\S]*history|migrated from/i);
    });
```

- [ ] **Step 3: Run it to verify it fails**

Run: `yarn workspace @bedrock/shared test src/chatbot/system-prompt.test.ts`
Expected: FAIL — the temporal instruction is not yet present.

- [ ] **Step 4: Add the temporal rule to the prompt**

In `system-prompt.ts`, add these lines to the ANTI-EMBELLISHMENT / grounding section:

```typescript
    'When the retrieved context includes lifecycle or migration information, lead with the',
    'current state as authoritative and present prior states as history ("migrated from X to Y");',
    'never present a superseded state as current.',
```

- [ ] **Step 5: Run the guard test to verify it passes**

Run: `yarn workspace @bedrock/shared test src/chatbot/system-prompt.test.ts`
Expected: PASS (all assertions, including the new temporal one).

- [ ] **Step 6: Commit**

```bash
git add applications/shared/src/chatbot/system-prompt.ts applications/shared/src/chatbot/system-prompt.test.ts
git commit -m "feat(chatbot): teach the prompt temporal framing for lifecycle context"
```

---

### Task 5: End-to-end verification

**Files:** none (verification only).

- [ ] **Step 1: Retrieval probe — confirm lifecycle/EKS ranks for the cluster question**

Run the retrieval probe used during discovery (query "How is your Kubernetes cluster set up?" through `PgVectorRetriever` for user `1d4c645a-…`) and confirm the top passages are the `lifecycle`/EKS content, not kubeadm. Record the top-3 sources.

- [ ] **Step 2: Live chatbot check (after Layer 1 is deployed)**

Once Layer 1 is merged and deployed, ask the live bot "How is your Kubernetes cluster set up?" and confirm the answer leads with Amazon EKS and frames kubeadm as prior/migrated. If Layer 1 is not yet deployed, record this step as BLOCKED-ON-DEPLOY (the data is correct; the old prompt still overrides live).

---

## Self-Review

**1. Spec coverage (Phase A rows of the spec):**
- Migration 104 (`lifecycle` chunk_type) → Task 1. ✓
- Direct seed of one lifecycle chunk for the owner's platform repo → Task 2. ✓
- Purge stale rows for excluded paths → Task 3. ✓
- Temporal prompt rule (§3) → Task 4. ✓
- Verify (§7) → Task 5. ✓
- Admin-only: Phase A targets the owner's data only; no non-owner rows touched (all queries scoped to `1d4c645a`). ✓

**2. Placeholder scan:** No TBD/TODO; every command is concrete with expected output; the content string, ids, model, and SQL are literal. ✓

**3. Type/id consistency:** owner `1d4c645a-…` and profile `0c4342ef-…` used identically across Tasks 2, 3, 5; `content_hash` computed the same way (sha256 of the content) in Task 2 Step 2 and referenced in Step 3. ✓

## Notes / forward dependencies

- **Convergence with Phase C:** the seeded row carries `metadata={"seeded":"phase-a"}`. Phase C's extractor will generate its own lifecycle text (likely different wording → different `content_hash` → a *second* row, not an upsert). Phase C MUST delete `chunk_type='lifecycle'` rows where `metadata->>'seeded'='phase-a'` for the profile before inserting, so the manual seed is superseded cleanly (recorded as a Phase C task).
- **kubernetes-platform** had no profile row (extraction absent/failed) and **tucaken-infra** profile is `3af58761-…`; Phase A seeds only kubernetes-bootstrap (the cluster-platform repo). If retrieval in Task 5 still under-ranks, seed tucaken-infra's profile too with the same content.
