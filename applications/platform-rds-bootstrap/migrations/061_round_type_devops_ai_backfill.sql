-- 061_round_type_devops_ai_backfill.sql — S5: seed the new DevOps/AI round_type values on
-- companies where the format is DOCUMENTED as the predominant technical round (cited, 2024-2026).
--
-- Honesty gate (a fresh source check was run): only seed a company whose PRIMARY technical round
-- is predominantly the new type; do NOT narrow a 'mixed' company. Result was intentionally thin:
--   * troubleshooting   — 0 companies. Every well-known SRE/PE loop (Meta PE, Google SRE, Cloudflare
--     SysRE, Cisco ThousandEyes) runs troubleshooting ALONGSIDE coding + design — never predominant.
--   * architecture-review — 0 companies. The strongest case (Airbnb "architecture review" / reverse
--     system design) is 1 of 4 co-equal rounds — not predominant. Left unseeded.
--   * hands-on-lab       — 1 company (openai), medium confidence (see below).
-- The enum + coach guidance + admin-api/UI wiring make all 3 values valid end-to-end regardless;
-- unseeded types are set per-application when a candidate knows their format.
-- Idempotent UPDATE (process_shape fully replaced).
BEGIN;

-- OpenAI Applied-AI / AI-Engineer technical round: a ~5h hands-on build on OpenAI APIs
-- (RAG / agent / eval harness) is the primary technical evaluation, with the deep-dive anchored
-- to it. 'hands-on-lab' is more specific than the prior 'practical'. Medium confidence: the onsite
-- also includes a design round. Sources: DataInterview "OpenAI AI Engineer Guide" (2026);
-- alexeygrigorev "AI Engineering Field Guide" (2025-2026). Retrieved 2026-06-02.
UPDATE company_interview_profiles
SET process_shape = '[{"stage":"technical-1","format":"~5h hands-on build on OpenAI APIs (RAG/agent/eval) + anchored deep-dive","note":"hands-on-lab: the practical AI build is the primary technical eval; medium confidence (onsite also has a design round). DataInterview OpenAI AI Engineer Guide 2026; alexeygrigorev AI Engineering Field Guide 2025-26","round_type":"hands-on-lab","confidence":"medium"}]'::jsonb,
    as_of = '2026-06-02'
WHERE company_key = 'openai';

COMMIT;
