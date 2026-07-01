# Phase A — Lifecycle Chunk Seed Runbook

Auditable, reproducible record of the one-off seed that inserts a single
`lifecycle` embedding chunk for the portfolio owner's kubernetes-bootstrap
profile. Phase C will find and replace this row using the
`metadata = {"seeded":"phase-a"}` marker.

## Target identifiers

| Field        | Value                                        |
|--------------|----------------------------------------------|
| `user_id`    | `1d4c645a-447e-4b5b-924d-19a3c75a84db`       |
| `profile_id` | `0c4342ef-6d23-4385-9f4c-19b878b7b05d`       |
| `chunk_type` | `lifecycle`                                  |
| `metadata`   | `{"seeded":"phase-a"}`                       |
| Table        | `repository_profile_embeddings`              |
| Embedding model | `amazon.titan-embed-text-v2:0` (1024-dim) |

## Content string (exact)

```
Kubernetes platform lifecycle: the cluster currently runs on Amazon EKS (Kubernetes 1.34, Karpenter-provisioned nodes, VPC CNI). It was migrated in 2026-05 from a self-managed kubeadm cluster; ArgoCD GitOps and Traefik ingress carried across the migration.
```

Verified facts: EKS 1.34, Karpenter, VPC CNI, migrated 2026-05 from kubeadm;
ArgoCD GitOps and Traefik ingress retained post-migration.

## Environment prefix (required for all steps)

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.3/bin:/opt/homebrew/bin:/usr/local/bin:$PATH" \
  AWS_PROFILE=dev-account \
  AWS_REGION=eu-west-1 \
  KUBECONFIG=$HOME/.kube/config
```

## Step 1 — Define the content string

```bash
CONTENT='Kubernetes platform lifecycle: the cluster currently runs on Amazon EKS (Kubernetes 1.34, Karpenter-provisioned nodes, VPC CNI). It was migrated in 2026-05 from a self-managed kubeadm cluster; ArgoCD GitOps and Traefik ingress carried across the migration.'
```

## Step 2 — Generate the embedding locally (Titan) and compute the content hash

The pod has no Bedrock SDK, so the embedding is generated locally and the result
is piped into the pod.

```bash
node -e "
const content = process.argv[1];
const body = JSON.stringify({inputText: content, dimensions: 1024, normalize: true});
const b64 = Buffer.from(body).toString('base64');
process.stdout.write(b64);
" "$CONTENT" > /tmp/titan-body.b64

aws bedrock-runtime invoke-model \
  --model-id amazon.titan-embed-text-v2:0 \
  --content-type application/json \
  --accept application/json \
  --body "$(cat /tmp/titan-body.b64)" \
  /tmp/titan-emb.json

node -e "
const fs = require('fs');
const crypto = require('crypto');
const c = process.argv[1];
const emb = JSON.parse(fs.readFileSync('/tmp/titan-emb.json','utf8')).embedding;
if (emb.length !== 1024) throw new Error('dim ' + emb.length);
const hash = crypto.createHash('sha256').update(c,'utf8').digest('hex');
fs.writeFileSync('/tmp/seed.json', JSON.stringify({content:c, contentHash:hash, embedding:emb}));
console.log('dim=', emb.length, 'hash=', hash);
" "$CONTENT"
```

**Expected:** `dim= 1024 hash= 91160f93356c9faa9e85c0b7475f1b432275ce77a308be80fb8b96a1b86e0b2c`

Note: the content contains no PII, so `sha256(content)` equals the pipeline's
`sha256(scrubbed content)` — Phase C will match on this hash.

## Step 3 — Insert the row via the admin-api pod under the owner's RLS context

```bash
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

**Expected:** `seeded ok`

The insert uses `ON CONFLICT (profile_id, chunk_type, content_hash) DO UPDATE` so
it is idempotent and safe to re-run.

## Step 4 — Verify the row is present and retrievable

```bash
POD=$(kubectl --context eks-dev -n admin-api get pods -o name | head -1); POD=${POD#pod/}

kubectl --context eks-dev -n admin-api exec "$POD" -- sh -c 'NODE_PATH=/app/node_modules node -e "const{Pool}=require(\"pg\");(async()=>{const p=new Pool({host:process.env.PG_HOST,port:+process.env.PG_PORT,database:process.env.PG_DATABASE,user:process.env.PG_USER,password:process.env.PG_PASSWORD});const r=await p.query(\"select chunk_type,left(content,60) c,metadata from repository_profile_embeddings where profile_id=\x270c4342ef-6d23-4385-9f4c-19b878b7b05d\x27 and chunk_type=\x27lifecycle\x27\");console.log(JSON.stringify(r.rows,null,2));await p.end();})()"'
```

**Expected:** exactly one row:

```json
[
  {
    "chunk_type": "lifecycle",
    "c": "Kubernetes platform lifecycle: the cluster currently runs on",
    "metadata": {
      "seeded": "phase-a"
    }
  }
]
```

## Actual execution record (2026-07-01)

- content_hash: `91160f93356c9faa9e85c0b7475f1b432275ce77a308be80fb8b96a1b86e0b2c`
- embedding length: 1024
- insert output: `seeded ok`
- verify output: one row, `chunk_type: "lifecycle"`, `metadata: {"seeded":"phase-a"}`
- pod used: `admin-api-75b85d6ff7-92v6x`

## Phase C notes

Phase C's pipeline will detect this row via `metadata->>'seeded' = 'phase-a'` and
replace it with a freshly generated chunk once the automated lifecycle extraction
is in place. The `content_hash` ensures the ON CONFLICT clause matches cleanly.
