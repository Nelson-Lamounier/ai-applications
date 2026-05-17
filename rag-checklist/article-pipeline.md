# Article-Pipeline — RAG Checklist (generation)

## RAG-Retrieval subset
- [ ] 2 Hybrid Search — PARTIAL — src/agents/research-agent.ts:190-247 vector-only KB/pgvector — Gap: no BM25 path
- [ ] 3 Reranking — MISSING — Gap: all 10 KB passages injected unranked
- [ ] 4 Context Window — PARTIAL — Gap: all passages passed to writer, no top-3
- [ ] 9 Semantic Cache — PARTIAL — prompt cache only (sub-project 3)

## Not applicable
- 1 (consumes pre-chunked KB), 8 (infra-layer)

## LLM-Safety subset
- [ ] 5 PII + toxicity — MISSING (CRITICAL) — Gap: no PII scrub on draft, no toxicity filter on output -> shared PiiScrubber (issue) + toxicity tracked separately
- [ ] 6 Grounding — PARTIAL — QA agent != grounding check — Gap: add shared grounding verifier post-QA, mode=flag (issue)
- [ ] 7 Zero-result — PARTIAL — research-agent.ts:191-193 degrades silently — Gap: no halt/instruction when KB empty
