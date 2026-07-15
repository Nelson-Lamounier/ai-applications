# lib/resume

Deterministic resume assembly and integrity -- everything that fills,
reconciles, or protects the tailored resume without an LLM call.

## Files

- `resume-skeleton.ts` -- deterministic resume skeleton; profile, education,
  and certifications copied verbatim, experience reduced to a roster, every
  agent-owned section starts empty so the reconciler can tell "not filled
  yet" from "genuinely empty".
- `resume-reconciler.ts` -- runs after the agent batches fill the skeleton;
  validates structural shape and refuses to ship required sections empty.
- `experience-roster.ts` -- anchors every resume experience entry to exactly
  one career-history entry, the identity ground truth.
- `preserve-resume-fields.ts` -- repairs lossy rewrite round-trips; restores
  fields a rewrite silently dropped without touching fields it changed.
- `summary-integrity.ts` -- last-line-of-defence gate on the resume summary,
  the most recruiter-visible artefact.
- `resume-prose.ts` -- extracts the tailored resume + cover letter into
  tagged `ProseSection[]` for `BedrockProseLinter`.
- `candidate-contact.ts` -- per-user identity for the resume profile and
  cover-letter signoff (multi-tenant correctness).
- `metrics-ledger.ts` -- grounded-metrics ledger, the supply side of the
  metric-honesty loop; extracts number-bearing sentences verbatim, no LLM.
- `claim-strength.ts` -- shared prompt rule for every pass that may rewrite
  resume text: claim strength is frozen, never inflated.

## Invariant

Resume content is either copied verbatim from a verified source or produced
by a deterministic closure with no invention. Any pass that may rewrite text
must preserve claim strength and never emit an unverified number.

## Adding a file here

Add to `resume/` if the file enforces resume assembly, reconciliation, or
truthfulness on the resume/cover-letter output -- even if a consumer outside
the resume pipeline (e.g. an ats/ agent) also imports it. The invariant
decides placement, not the caller.
