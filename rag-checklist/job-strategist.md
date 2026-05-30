# Job-Strategist — RAG Checklist

## RAG-Retrieval subset
- [ ] 2 Hybrid Search — PARTIAL — src/agents/research-agent.ts:138 useHybrid=true — Gap: fusion unverified in this app
- [x] 3 Reranking — IMPLEMENTED — src/agents/research-agent.ts:177-219 rerank + cosine fallback — no gap
- [ ] 4 Context Window — PARTIAL — research-agent.ts:83 MAX_KB_PASSAGES=15 — Gap: checklist wants top-3
- [x] 8 HNSW — IMPLEMENTED — research-agent.ts:113-140 over-fetch via HNSW — Gap: M/ef_construction undocumented
- [ ] 9 Semantic Cache — MISSING — Gap: prompt cache only, no response cache (sub-project 3)

## Not applicable
- 1 Chunking — chunking is upstream (ingestion); this app reads pre-chunked rows

## LLM-Safety subset
- [x] 5 PII + toxicity — IMPLEMENTED — research-agent.ts:40-54 PII patterns + strategist-agent.ts:532 output sanitise — Gap: migrate to shared PiiScrubber for redaction parity (issue)
- [ ] 6 Grounding — PARTIAL — prompt truthfulness mandate only — Gap: no backward verify -> shared grounding verifier, mode=block (issue)
- [ ] 7 Zero-result — PARTIAL — research-agent.ts:149 returns [] — Gap: no explicit "insufficient data" fallback
