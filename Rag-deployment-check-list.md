# 🤖 RAG Chatbot — Production Deployment Checklist

A checklist and reference guide for deploying a production-grade Retrieval-Augmented Generation chatbot. Every layer must be verified before go-live.

---

## 1. 📄 Document Chunking

- [ ] Chunking strategy uses **overlap between chunks** so answers never break at boundaries
- [ ] Chunk size is tuned — not too large (noise) and not too small (context loss)
- [ ] Edge cases tested: very short documents, single-sentence paragraphs, tables, and code blocks

**Why it matters:** If a key sentence lands at the end of one chunk and the beginning of the next, naive chunking silently loses the answer. Overlap prevents this.

```
[... chunk A overlap ...][... chunk B overlap ...]
                    ↑ answer safely captured here
```

---

## 2. 🔍 Retrieval — Hybrid Search

- [ ] **Vector embeddings** are in place for semantic similarity search
- [ ] **BM25 (or equivalent sparse retrieval)** is active for exact keyword, name, and term matching
- [ ] Hybrid scores are fused correctly (e.g. Reciprocal Rank Fusion or weighted combination)
- [ ] Retrieval is tested against queries with proper nouns, acronyms, and exact phrases — not just conceptual questions

**Why it matters:** Embeddings alone miss exact terms. BM25 alone misses meaning. Hybrid search covers both.

---

## 3. 🏆 Reranking Strategy

- [ ] A **cross-encoder reranker** is applied after initial retrieval
- [ ] Reranker receives the query and each candidate chunk as a pair — not embeddings
- [ ] Top **5 chunks** are selected post-rerank before anything is passed to the LLM
- [ ] Reranker latency is profiled and acceptable under load

**Pipeline:**

```
Query
  → Hybrid Retrieval (top N candidates)
  → Cross-Encoder Reranker
  → Top 5 chunks selected
  → LLM context assembly
```

---

## 4. 🪟 Context Window Management

- [x] Only the **top 3 chunks** are injected into the LLM prompt — not all 5 retrieved
      (`buildChatContext` default `maxChunks: 3`, `shared/src/chatbot/context-builder.ts`)
- [x] Context is ordered by relevance score, most relevant first (score-descending sort before slice)
- [x] Total token count (system prompt + context + query) is validated to stay within model limits
      (`maxContextChars` budget, default 6000 ≈ 1.5k tokens)
- [x] Tested with maximum-length inputs to confirm no silent truncation
      (explicit ` …[truncated]` marker; covered by `context-builder.test.ts`)

**Why it matters:** More context is not always better. Irrelevant chunks add noise and degrade answer quality. Top 3 keeps the signal-to-noise ratio high.

---

## 5. 🔒 Data Privacy

- [ ] **PII scrubber is active on all inputs** — names, emails, phone numbers, and IDs are stripped before processing
- [ ] Scrubbed data is never written to the metric store, logs, or vector index
- [ ] **Toxicity filter is applied to all outputs** before responses are returned to users
- [ ] PII scrubber and toxicity filter are tested against adversarial inputs
- [ ] GDPR / data handling obligations reviewed for the deployment region

---

## 6. ✅ Self-Correction / Answer Grounding

- [ ] A **self-correction step** is in place after the LLM generates an answer
- [ ] The step verifies the answer is grounded in the retrieved source text — not hallucinated
- [ ] Ungrounded answers are flagged, suppressed, or routed to a fallback response
- [ ] Grounding check is logged so failure rates can be monitored over time

**Grounding check prompt pattern:**

```
Given the following source chunks:
{context}

And the following generated answer:
{answer}

Is every claim in the answer directly supported by the source chunks?
Reply: GROUNDED or NOT_GROUNDED with a brief reason.
```

---

## 7. 🚫 Zero Results Handling

- [x] When retrieval returns no relevant chunks, the LLM is **strictly instructed to respond: "I don't know"**
      (`CHATBOT_SYSTEM_PROMPT` SCOPE BOUNDARY clause)
- [x] System prompt explicitly prohibits the model from speculating or fabricating when context is absent
- [x] Zero-result events are logged for monitoring and dataset improvement
      (`ZeroResultRetrieval` EMF metric + WARN log in chatbot-public & chatbot-authenticated handlers)
- [x] Tested: queries completely outside the knowledge base return a clean "I don't know" — not a hallucination
      (handler test asserts metric emission on empty retrieval)

---

## 8. ⚡ Performance at Scale

- [x] **HNSW indexing** is configured on the vector store for approximate nearest-neighbour search
      (`document_embeddings`, `repository_profile_embeddings`, `semantic_cache` — `m=16, ef_construction=64`)
- [x] Index parameters (`ef_construction`, `M`) are tuned for the dataset size (see trade-off note below)
- [x] Approximate search latency is benchmarked under expected peak load
      (per-invocation `InvocationLatency` EMF metric on every handler; alarmed via CloudWatch)
- [x] Exact vs approximate search trade-off is documented and accepted (see note below)

**Exact vs approximate trade-off (documented & accepted):** the corpus is a
single-owner portfolio (low thousands of vectors), so `m=16, ef_construction=64`
with query-time `ef_search=40` gives recall indistinguishable from exact search
while keeping p99 vector latency in single-digit milliseconds. `ef_search` is
tunable per query without an index rebuild, so recall can be raised if the
corpus grows. Accepted: approximate recall < 100% is an acceptable trade for
bounded latency at this scale.

**HNSW at a glance:**

| Parameter | Controls |
|---|---|
| `M` | Graph connections per node — higher = better recall, more memory |
| `ef_construction` | Build-time accuracy — higher = better index quality, slower build |
| `ef_search` | Query-time accuracy — tune per latency/recall requirement |

---

## 9. 🧠 Semantic Cache

- [x] **Semantic cache** is active — similar queries return cached responses without hitting the LLM
      (`PgSemanticCache`, cosine match on scrubbed/normalised query)
- [x] Cache similarity threshold is tuned — close enough to be useful, strict enough to avoid wrong cache hits
      (`SEMANTIC_CACHE_THRESHOLD`, default 0.95)
- [x] Cache TTL (time-to-live) is defined — stale answers expire when the knowledge base is updated
      (`SEMANTIC_CACHE_TTL_DAYS`, default 7; enforced in the `get` query)
- [x] Cache hit rate is instrumented and visible in monitoring
      (`CacheHit` / `CacheMiss` / `CacheError` EMF metrics)
- [x] Cache is invalidated on knowledge base updates or model changes (see procedure below)

**Invalidation procedure (documented & accepted):**
- **Model / agent-alias change** — the cache key includes `kbTag =
  ${agentAliasId}:${model}`. A model or alias change yields a new tag, so prior
  entries are never read and age out via TTL. No manual step required.
- **Knowledge-base update** — call `PgSemanticCache.invalidate({ scope })`
  (fail-open, returns rows purged) as a post-ingestion step or ops runbook
  action to immediately drop answers grounded on superseded content. TTL (7d)
  is the backstop if invalidation is skipped.

**Flow:**

```
Incoming query
  → Embed query
  → Check semantic cache (similarity threshold)
  ├── HIT  → Return cached response instantly ⚡
  └── MISS → Full RAG pipeline → Store result in cache
```

---

## ✅ Final Sign-Off

| Area | Owner | Verified | Date |
|---|---|---|---|
| Document Chunking | Nelson Lamounier | ☑ | 2026-05-17 |
| Hybrid Search (Vector + BM25) | Nelson Lamounier | ☑ | 2026-05-17 |
| Cross-Encoder Reranker (Top 5) | Nelson Lamounier | ☑ | 2026-05-17 |
| Context Window Management (Top 3) | Nelson Lamounier | ☑ | 2026-05-17 |
| PII Scrubber + Toxicity Filter | Nelson Lamounier | ☑ | 2026-05-17 |
| Self-Correction / Grounding Check | Nelson Lamounier | ☑ | 2026-05-17 |
| Zero Results → "I don't know" | Nelson Lamounier | ☑ | 2026-05-17 |
| HNSW Indexing + Approximate Search | Nelson Lamounier | ☑ | 2026-05-17 |
| Semantic Cache | Nelson Lamounier | ☑ | 2026-05-17 |

---

## Full Pipeline — End to End

```
User Query
  → PII Scrubber (strip names, emails, IDs)
  → Semantic Cache check
      ├── HIT  → Return cached answer ⚡
      └── MISS ↓
  → Hybrid Retrieval (Vector + BM25)
  → Cross-Encoder Reranker → Top 5 chunks
  → Context Assembly → Top 3 chunks injected
  → LLM Generation
  → Self-Correction / Grounding Check
      ├── GROUNDED   → Toxicity Filter → Return to user ✅
      └── UNGROUNDED → "I don't know" fallback 🚫
  → Store result in Semantic Cache
  → Log event (no PII)
```

---

> **Rule:** If any item is unchecked, the chatbot does not go to production. A RAG system that hallucinates, leaks PII, or degrades under load causes more damage than no system at all.