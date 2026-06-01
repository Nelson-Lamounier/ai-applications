-- 052_company_round_type.sql — annotate seeded company process_shape stages with round_type.
-- Source: Glassdoor / public eng-interview reports, retrieved 2026-06-01.
--   Amazon technical round (technical-1): DSA / LeetCode-style per Glassdoor + IGotAnOffer / BeTopTen reports.
--   Stripe technical round (technical-1): practical / applied coding per Glassdoor Stripe interview reports.
--   Phone-screen for both companies: recruiter behavioural screen, no live coding.
--   Final-round (onsite loop) for both companies: mix of coding + system design + behavioural = mixed.
-- Idempotent: UPDATE is safe to re-run — process_shape column is fully replaced each time.
BEGIN;

UPDATE company_interview_profiles
SET process_shape = '[{"stage":"phone-screen","format":"recruiter screen","note":"Fit + logistics + comp alignment","round_type":"behavioral"},{"stage":"technical-1","format":"technical phone (coding)","note":"One coding problem, LP probing begins","round_type":"dsa"},{"stage":"final-round","format":"onsite loop (4-5)","note":"Coding, system design, behavioural — every round scored against LPs","round_type":"mixed"}]'::jsonb
WHERE company_key = 'amazon';

UPDATE company_interview_profiles
SET process_shape = '[{"stage":"phone-screen","format":"recruiter screen","note":"Fit + role interest","round_type":"behavioral"},{"stage":"technical-1","format":"technical phone","note":"Practical coding close to real product work","round_type":"practical"},{"stage":"final-round","format":"onsite (4 rounds)","note":"2 coding, 1 system design, 1 behavioural","round_type":"mixed"}]'::jsonb
WHERE company_key = 'stripe';

COMMIT;
