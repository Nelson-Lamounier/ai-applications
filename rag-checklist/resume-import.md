# Resume-Import-Processor — RAG Checklist (pipeline)

## Not applicable
- 1 (no overlap needed — semantic chunks), 2,3,4 (batch, not query-driven), 8 (write-heavy), 9 (Tavily cache already present)

## LLM-Safety subset
- [ ] 5 PII — MISSING (CRITICAL) — Gap: names/emails/employers flow raw to Bedrock/Tavily/DB/logs -> shared PiiScrubber before every sink (issue)
- [ ] 6 Grounding — PARTIAL — prompt rules in src/bedrock/gap-analysis.ts:128-139 — Gap: no post-gen verify of gap suggestions -> shared grounding verifier, mode=flag (issue)
- [ ] 7 Zero-result — PARTIAL — src/bedrock/enrich-role.ts:94-113 skips gracefully — Gap: no user-facing "limited research" notice on total Tavily failure
