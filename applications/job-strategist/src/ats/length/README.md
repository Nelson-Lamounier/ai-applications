# length/

2-page PDF budget enforcement. `applyLengthBudget` measures the resume and, if over,
runs a bounded LLM condense (or expand if under-full) with a deterministic hard-trim
backstop. Runs pre-render in `run-pipeline.ts`.
