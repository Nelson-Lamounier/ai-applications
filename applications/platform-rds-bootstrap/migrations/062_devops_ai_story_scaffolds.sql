-- 062_devops_ai_story_scaffolds.sql — S6: DevOps/AI STAR-style story STRUCTURES (constraint-only)
-- for the prep_scaffolds table. Reuses kind='story_scaffold' (alongside star/car/sar). The
-- `structure` is step prompts/labels only — questions the candidate answers from their OWN
-- evidence; NEVER example stories. Mirrors 049's `star` row shape. Idempotent.
BEGIN;

INSERT INTO prep_scaffolds (id, kind, title, structure, source, as_of) VALUES
('incident-response','story_scaffold','Incident response',
 '{"steps":[{"key":"detection","label":"Detection","prompt":"How was the incident noticed (alert, user report, metric)?"},{"key":"diagnosis","label":"Diagnosis","prompt":"How did you form and narrow hypotheses to isolate the cause?"},{"key":"mitigation","label":"Mitigation","prompt":"What did YOU do to stop the bleeding, and why that first?"},{"key":"root_cause","label":"Root cause","prompt":"What was the underlying cause (not just the symptom)?"},{"key":"prevention","label":"Prevention","prompt":"What changed afterwards so it cannot recur?"}]}'::jsonb,
 'STAR-style incident/postmortem narrative structure (SRE interview convention)','2026-06-02'),
('system-migration','story_scaffold','System migration',
 '{"steps":[{"key":"motivation","label":"Motivation","prompt":"Why migrate — what constraint or risk forced it?"},{"key":"approach","label":"Approach & rollback","prompt":"Your strategy and the rollback/safety plan."},{"key":"cutover","label":"Cutover","prompt":"How you moved traffic/data with minimal disruption."},{"key":"validation","label":"Validation","prompt":"How you proved correctness/parity after."},{"key":"outcome","label":"Outcome","prompt":"Measurable result and what you would change."}]}'::jsonb,
 'STAR-style migration narrative structure','2026-06-02'),
('cost-optimization','story_scaffold','Cost optimization',
 '{"steps":[{"key":"baseline","label":"Baseline","prompt":"What was the cost and how did you measure it?"},{"key":"hypothesis","label":"Hypothesis","prompt":"What did you believe was driving the cost?"},{"key":"change","label":"Change","prompt":"The concrete change YOU made."},{"key":"measured","label":"Before/after","prompt":"The measured before/after impact (numbers)."},{"key":"tradeoff","label":"Tradeoff","prompt":"What you traded off and why it was acceptable."}]}'::jsonb,
 'STAR-style cost/FinOps narrative structure','2026-06-02'),
('ai-eval-building','story_scaffold','AI eval-building',
 '{"steps":[{"key":"problem","label":"Quality problem","prompt":"What output-quality problem prompted building evals?"},{"key":"eval_design","label":"Eval design","prompt":"Your golden set / rubric / metric and why."},{"key":"baseline","label":"Baseline","prompt":"What the baseline scored before changes."},{"key":"iteration","label":"Iteration","prompt":"How evals drove your prompt/model/RAG changes."},{"key":"regression","label":"Regression guard","prompt":"How the evals now prevent regressions."}]}'::jsonb,
 'STAR-style AI eval/quality narrative structure','2026-06-02'),
('reliability-scaling','story_scaffold','Reliability & scaling',
 '{"steps":[{"key":"target","label":"SLO/target","prompt":"The reliability or scale target you owned."},{"key":"bottleneck","label":"Bottleneck","prompt":"How you found the limiting factor."},{"key":"change","label":"Change","prompt":"The concrete change YOU made."},{"key":"impact","label":"Load/impact","prompt":"The measured impact under real load."},{"key":"next","label":"Next step","prompt":"What you would do next or differently."}]}'::jsonb,
 'STAR-style reliability/scaling narrative structure','2026-06-02')
ON CONFLICT (id) DO UPDATE SET
  kind=EXCLUDED.kind, title=EXCLUDED.title, structure=EXCLUDED.structure,
  source=EXCLUDED.source, as_of=EXCLUDED.as_of;

COMMIT;
