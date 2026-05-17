# Ingestion — RAG Checklist (pipeline producer)

## RAG-Retrieval subset
- [x] 1 Chunking — IMPLEMENTED — shared/src/ingestion/implementations/MarkdownChunker.ts:73-81 overlapChars=200 — Gap: table/code-block edge cases untested
- [x] 2 Hybrid Search (index build) — IMPLEMENTED — RdsVectorStore.ts:256-318 tsvector + vector — no gap
- [ ] 8 HNSW — PARTIAL — query-side ef_search present — Gap: M/ef_construction not documented/tuned

## Not applicable
- 3,4,6,7,9 — ingestion stores chunks; retrieval/generation/grounding/cache live in consumer apps

## LLM-Safety subset
- [ ] 5 PII — MISSING — Gap: README/commit/manifest text -> Bedrock + vector store unscrubbed -> shared PiiScrubber before extract + persist (issue)
