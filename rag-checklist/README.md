# RAG Checklist — Split Model

`Rag-deployment-check-list.md` (repo root) is the canonical chatbot
checklist. It splits into two subsets applied per app:

## RAG-Retrieval subset (1-4, 8, 9)
Chunking, Hybrid Search, Reranking, Context Window, HNSW, Semantic Cache.
Applies to query-driven apps and the pipeline producers that own those
stages.

## LLM-Safety subset (5-7)
PII + toxicity, Grounding/self-correction, Zero-result handling.
Applies to every app that calls an LLM — pipeline or query.

## Per-app coverage

| App | Class | Retrieval subset | Safety subset |
|---|---|---|---|
| chatbot | query | all | all |
| job-strategist | query | 2,3,4,8,9 | all |
| ingestion | pipeline producer | 1,2,8 | 5 |
| resume-import | pipeline | n/a | 5,6,7 |
| article-pipeline | generation | 2 (consumes KB) | 5,6,7 |

Each per-app file lists only applicable items as checkboxes with
Status / Evidence / Gap from the 2026-05-16 audit. Shared remediation
is tracked by the two GitHub issues (PII scrubber, grounding verifier).
