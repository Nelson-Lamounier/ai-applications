# Chatbot — RAG Checklist

## RAG-Retrieval subset
- [x] 1 Chunking — IMPLEMENTED — shared/src/ingestion/implementations/DefaultChunker.ts:49-78 overlap via stride — no gap
- [x] 2 Hybrid Search — IMPLEMENTED — shared/src/rds/implementations/RdsVectorStore.ts:256-318 RRF k=60 — no gap
- [ ] 3 Reranking — PARTIAL — shared/src/retrieval/implementations/BedrockReranker.ts:75-131 exists — Gap: chatbot Lambda never calls it
- [ ] 4 Context Window — MISSING — Gap: Bedrock Agent retrieval opaque, no top-3 enforcement
- [x] 8 HNSW — IMPLEMENTED — RdsVectorStore.ts:222-224 ef_search=40 — Gap: M/ef_construction undocumented
- [ ] 9 Semantic Cache — MISSING — Gap: no response cache (sub-project 3)

## LLM-Safety subset
- [ ] 5 PII + toxicity — PARTIAL — shared/src/security/output-sanitiser.ts:94-138 redacts infra IDs — Gap: no input PII scrub -> shared PiiScrubber (issue)
- [ ] 6 Grounding — PARTIAL — Bedrock Guardrail filters server-side — Gap: no app-level verify/log -> shared grounding verifier, mode=block (issue)
- [ ] 7 Zero-result — PARTIAL — instructed in persona — Gap: untested, not instrumented
