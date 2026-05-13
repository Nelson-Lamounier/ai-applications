# Phase 3: Chatbot → Custom RAG Lambda — Design Spec

**Date:** 2026-05-13
**Phase:** 3 of 3 (Unified KB on RDS pgvector)
**Status:** Approved

---

## Goal

Replace the managed Bedrock Agent + Pinecone KB retrieval path in the chatbot with two purpose-built Lambda functions (`chatbot-public` and `chatbot-authenticated`) that perform direct RDS pgvector retrieval via `PgVectorRetriever` and generate responses via Claude Converse API. The existing Bedrock Agent remains live behind a `CHATBOT_RETRIEVAL_SOURCE` feature flag until cutover.

This is Phase 3 of the three-phase KB unification:
- **Phase 1 (done):** Tier-1 profile extraction → `repository_profiles` + `repository_profile_embeddings`
- **Phase 2 (done):** Article pipeline Research Agent → pgvector
- **Phase 3 (this spec):** Chatbot → custom RAG Lambda

---

## Context

Current state: a single `chatbot` Lambda invokes `InvokeAgentCommand` against a managed Bedrock Agent. The agent handles retrieval (Pinecone KB), multi-query dispatch, guardrails, and response formatting internally via a 222-line system instruction. Sessions are stateless — Bedrock Agent Runtime correlates turns by `sessionId` internally.

Phase 3 moves all of this into code:
- Multi-query dispatch runs in Lambda (3 parallel `PgVectorRetriever` calls)
- Claude Converse API replaces `InvokeAgentCommand`
- System prompt migrates from the CDK agent instruction into `@bedrock/shared`
- Conversation history for authenticated users persists in RDS

---

## Two Usage Contexts

### Public Portfolio (`frontend-portfolio`)

Anonymous visitors to the public portfolio website. No authentication. The chatbot answers questions about the portfolio owner's work.

- **Retrieval userId:** `PORTFOLIO_OWNER_USER_ID` env var (fixed; owner's UUID)
- **Session persistence:** none — `sessionId` echoed back for client-side continuity only
- **Auth at gateway:** API key only
- **callerRole:** passed in request body (`recruiter` / `engineer` / `unknown`), adjusts system prompt framing

### Authenticated SaaS (`tucaken-app`)

Logged-in users of the SaaS app. The chatbot answers questions about the **logged-in user's own** portfolio data.

- **Retrieval userId:** extracted from Cognito JWT claim (`sub`) validated by API Gateway authorizer
- **Session persistence:** RDS `chat_sessions` + `chat_messages`, keyed by `user_id`
- **Auth at gateway:** API key + Cognito JWT authorizer
- **History window:** last 20 messages loaded on every turn, passed as `messages[]` to Converse API

---

## Architecture

### Application Structure

```
applications/
  chatbot-public/
    src/
      index.ts              ← Lambda handler
      env.ts                ← env var parsing + validation
      retrieval.ts          ← multi-query dispatch (expandQuery + Promise.all)
      context-builder.ts    ← RetrievedPassage[] → XML context block
      response-parser.ts    ← parse Claude JSON { prose, metrics, tags, followUp }
      security/
        input-sanitiser.ts  ← reused from existing chatbot/
        output-sanitiser.ts ← reused from existing chatbot/
    package.json
    tsconfig.json
  chatbot-authenticated/
    src/
      index.ts
      env.ts
      retrieval.ts          ← identical to chatbot-public/src/retrieval.ts
      context-builder.ts    ← identical to chatbot-public/src/context-builder.ts
      response-parser.ts    ← identical to chatbot-public/src/response-parser.ts
      session-store.ts      ← RDS read/write for chat_sessions + chat_messages
      security/
        input-sanitiser.ts
        output-sanitiser.ts
    package.json
    tsconfig.json
```

### Shared (`@bedrock/shared`) — new exports

| Export | Purpose |
|--------|---------|
| `buildChatContext(passages: RetrievedPassage[]): string` | Formats retrieved passages as `<retrieved_context>` XML block |
| `CHATBOT_SYSTEM_PROMPT` | Simplified system prompt (migrated from `chatbot-persona.ts`) |
| `ChatbotResponse` type | `{ prose: string; metrics: Metric[]; tags: string[]; followUp: string }` |
| `Metric` type | `{ label: string; value: string }` |

`PgVectorRetriever` and `TitanEmbeddingProvider` already exported — no changes.

### Feature Flag

Both Lambdas read:
```typescript
const CHATBOT_RETRIEVAL_SOURCE = (): string =>
  process.env['CHATBOT_RETRIEVAL_SOURCE'] ?? 'bedrock-agent';
```

- `'bedrock-agent'` (default): invoke existing Bedrock Agent path — zero-arg function enables per-test env override
- `'rds-pgvector'`: new pgvector RAG path

The existing `chatbot` Lambda and Bedrock Agent stack remain untouched until `CHATBOT_RETRIEVAL_SOURCE=rds-pgvector` is set in production.

---

## Database (Migration 015)

**File:** `applications/platform-rds-bootstrap/migrations/015_chat_sessions.sql`

Only the authenticated Lambda reads and writes these tables. The public Lambda has no database writes.

```sql
CREATE TABLE chat_sessions (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ON chat_sessions (user_id);
CREATE INDEX ON chat_sessions (user_id, updated_at DESC);

CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON chat_sessions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE chat_messages (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID        NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT        NOT NULL CHECK (role IN ('user', 'assistant')),
  content    TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ON chat_messages (session_id, created_at ASC);
CREATE INDEX ON chat_messages (user_id);

ALTER TABLE chat_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY rls_chat_sessions ON chat_sessions
  USING (user_id = current_setting('app.current_user_id', true)::uuid)
  WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON chat_sessions TO tucaken_app;

ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY rls_chat_messages ON chat_messages
  USING (user_id = current_setting('app.current_user_id', true)::uuid)
  WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON chat_messages TO tucaken_app;
```

**`title`**: set from the first 60 chars of the first user message, on session creation only.

---

## API Contracts

Both Lambdas share the same request/response shape — no frontend changes required.

```typescript
// Request (POST body)
interface ChatRequest {
  prompt:      string;
  sessionId?:  string;   // UUID; generated server-side if absent
  callerRole?: 'recruiter' | 'engineer' | 'unknown';
}

// Response
interface ChatResponse {
  response:  string;   // JSON.stringify({ prose, metrics, tags, followUp })
  sessionId: string;
}
```

For `chatbot-authenticated`: `userId` comes from the API Gateway authorizer context (`event.requestContext.authorizer.claims.sub`), never from the request body.

---

## Retrieval Strategy

### Multi-Query Dispatch

`expandQuery(userQuestion: string): [string, string]` generates two reformulated queries from the original. All three run in `Promise.all` against `PgVectorRetriever`:

```typescript
// Query 1: original
const q1 = userQuestion;
// Query 2: outcomes framing
const q2 = `${topic} deployment reliability outcomes production results`;
// Query 3: architecture framing
const q3 = `${topic} infrastructure architecture design patterns tools`;

const [r1, r2, r3] = await Promise.all([
  retriever.retrieve(userId, q1, opts),
  retriever.retrieve(userId, q2, opts),
  retriever.retrieve(userId, q3, opts),
]);
```

`topic` is extracted from `userQuestion` by stripping stop words and taking the first meaningful noun phrase (regex-based, no LLM call).

Results from all three queries are merged, deduplicated by `(sourceUri + text)` SHA-256 hash, sorted by score descending, and the top 8 are kept.

### PgVectorRetriever Options

| Option | Value |
|--------|-------|
| `maxProfiles` | 5 |
| `maxChunks` | 8 |
| `profileWeight` | 1.5 |

### Context Block

`buildChatContext(passages)` produces:

```xml
<retrieved_context>
  <passage source="profile" repo="owner/k8s-operator" score="0.92">
    Automated Kubernetes drift remediation across multi-env EKS clusters.
  </passage>
  <passage source="chunk" file="pkg/reconcile/loop.go" score="0.78">
    This file implements the reconciliation loop...
  </passage>
</retrieved_context>
```

### Claude Invocation

```typescript
// Converse API call (same runAgent pattern as article-pipeline)
{
  modelId:  CHATBOT_MODEL,   // env var; default: eu.anthropic.claude-sonnet-4-6-...
  system:   [{ text: CHATBOT_SYSTEM_PROMPT + callerRoleSuffix + retrievedContext }],
  messages: conversationHistory,   // [] for public; last-20 for authenticated
  inferenceConfig: { maxTokens: 1024, temperature: 0.3 },
}
```

System prompt enforces strict JSON output: `{ prose, metrics, tags, followUp }`.

---

## Session Store (`chatbot-authenticated` only)

`SessionStore` class in `session-store.ts`, constructor `(pool: Pool)`. Every method wraps SQL in `BEGIN` / `SET LOCAL app.current_user_id = $1` / `COMMIT`.

```typescript
class SessionStore {
  // Load last 20 messages for a session (validates ownership)
  loadHistory(userId: string, sessionId: string): Promise<ChatMessage[]>

  // Create session (inserts chat_sessions row, title from first 60 chars of prompt)
  createSession(userId: string, sessionId: string, title: string): Promise<void>

  // Persist one user turn + one assistant turn atomically
  saveTurn(userId: string, sessionId: string, userText: string, assistantText: string): Promise<void>
}
```

**Cross-user guard:** `loadHistory` checks `session.user_id = userId` before returning data. If mismatch: throw `SessionOwnershipError` → Lambda returns 403.

---

## CDK Changes

- **New `ChatbotPublicStack`**: Lambda (`chatbot-public`), `/invoke-public` API Gateway resource, api-key auth, no VPC (no RDS access needed — public Lambda is stateless)
- **New `ChatbotAuthenticatedStack`**: Lambda (`chatbot-authenticated`), `/invoke-authenticated` API Gateway resource, api-key + Cognito JWT authorizer, VPC-attached (RDS access via PgBouncer)
- **Existing `BedrockAgentStack` + `BedrockApiStack`**: untouched; `/invoke` endpoint live for rollback

**New env vars (CDK-wired via SSM / Secrets Manager):**

| Var | Lambdas | Source |
|-----|---------|--------|
| `CHATBOT_RETRIEVAL_SOURCE` | both | CDK literal (`'rds-pgvector'`) |
| `PORTFOLIO_OWNER_USER_ID` | public | SSM param |
| `CHATBOT_MODEL` | both | SSM param |
| `EMBEDDING_DIMENSION` | both | SSM param (default `1024`) |
| `RDS_HOST` | authenticated | SSM param |
| `RDS_PORT` | authenticated | SSM param |
| `RDS_DB_NAME` | authenticated | SSM param |
| `RDS_USER` | authenticated | SSM param |
| `RDS_PASSWORD` | authenticated | Secrets Manager |

---

## Tests

| File | Cases |
|------|-------|
| `chatbot-public/src/__tests__/handler.test.ts` | pgvector path returns `{ response, sessionId }`; bedrock-agent path calls InvokeAgentCommand; sanitiser blocks injection pattern; missing `prompt` → 400; `sessionId` echoed unchanged |
| `chatbot-public/src/__tests__/retrieval.test.ts` | `expandQuery` returns 3 non-empty strings; all 3 retriever calls fire in parallel; deduplication removes duplicate `sourceUri+text`; top-8 cap enforced |
| `chatbot-authenticated/src/__tests__/handler.test.ts` | History loaded before Claude call; new `sessionId` auto-created; cross-user `sessionId` → 403; pgvector path; bedrock-agent fallback |
| `chatbot-authenticated/src/__tests__/session-store.test.ts` | `loadHistory` returns last 20 in order; `saveTurn` inserts both rows in one transaction; `createSession` sets title from first 60 chars; cross-user guard throws |
| `shared/src/__tests__/buildChatContext.test.ts` | XML structure matches fixture; empty array → empty `<retrieved_context/>`; score formatted to 2dp |

All Bedrock and RDS calls mocked. No live calls.

---

## Out of Scope (Phase 3)

- Frontend UI changes in `frontend-portfolio` or `tucaken-app` (API contract unchanged)
- Chat history UI in `tucaken-app` (session persistence is Lambda-side only)
- Decommissioning the Bedrock Agent stack (post-cutover, separate task)
- `BedrockReranker` integration (can be added post-Phase 3)
- Streaming responses (current contract is buffered JSON)
- Rate limiting per `userId` (beyond existing API Gateway usage plan)

---

## Acceptance Criteria

- [ ] Migration `015_chat_sessions.sql` applies cleanly against local Postgres
- [ ] RLS verified: cross-user session query returns zero rows
- [ ] `chatbot-public` returns correct `{ response, sessionId }` with `CHATBOT_RETRIEVAL_SOURCE=rds-pgvector`
- [ ] `chatbot-public` falls back to Bedrock Agent with `CHATBOT_RETRIEVAL_SOURCE=bedrock-agent`
- [ ] `chatbot-authenticated` loads history and passes it to Claude Converse
- [ ] Cross-user `sessionId` rejected with 403
- [ ] 3 parallel retriever queries fire per request
- [ ] Deduplication removes duplicate passages across query results
- [ ] `buildChatContext` XML matches expected structure
- [ ] All tests pass; existing `chatbot` tests unbroken
- [ ] `tsc -b` clean across monorepo
- [ ] Both Lambda Docker images build
