# Local Reproduction: why the enrichment eval recall is low

**Date**: 2026-06-20 | **Method**: instead of another Bedrock eval Job, I (Claude
Code) acted as the enricher — applied the enricher's system prompt to 5 real
tucaken-infra chunks by hand, compared my per-chunk extraction to the stored
production-Haiku skills (a prior independent run), then did the packed extraction,
and categorised every skill. This makes the cause *visible* instead of inferred
from an aggregate number.

## The 5 chunks (all `.checkov/` — cohesive, easy to agree on)

Per chunk: **B** = stored production-Haiku skills (run 1, the baseline). **M** =
my independent per-chunk extraction (run 2). Each baseline skill tagged: `=`
exact, `~` semantic match (re-phrased / re-grained), `x` genuine miss.

### 1. `.checkov/config.yaml`
- B: infrastructure as code scanning, checkov, cloudformation security, iac security compliance, aws security controls
- M: checkov, infrastructure as code scanning, cloudformation security, security policy exceptions, ci/cd security
- `=` checkov, iac scanning, cloudformation security (3) · `~` iac security compliance≈security policy exceptions (1) · `x` aws security controls (1)
- **exact 0.60 · semantic 0.80**

### 2. `asg_rules.py#0`
- B: checkov, cloudformation security validation, auto scaling group configuration, elb health checks, infrastructure as code
- M: checkov custom checks, auto scaling group configuration, elb health checks, infrastructure as code, python
- `=` asg configuration, elb health checks, iac (3) · `~` checkov≈checkov custom checks (1) · `x` cloudformation security validation (1)
- **exact 0.60 · semantic 0.80**

### 3. `asg_rules.py#1`
- B: checkov, aws autoscaling groups, infrastructure security validation, python resource checks
- M: auto scaling group configuration, high availability, checkov, python resource checks
- `=` checkov, python resource checks (2) · `~` aws autoscaling groups≈asg configuration (1) · `x` infrastructure security validation (1)
- **exact 0.50 · semantic 0.75**

### 4. `compute_rules.py#0`
- B: checkov custom rules, cloudformation security checks, ec2 userdata analysis, credential detection, infrastructure as code, python regex patterns
- M: checkov custom rules, ec2 security, credential detection, infrastructure as code, python
- `=` checkov custom rules, credential detection, iac (3) · `~` ec2 userdata analysis≈ec2 security, python regex patterns≈python (2) · `x` cloudformation security checks (1)
- **exact 0.50 · semantic 0.83**

### 5. `compute_rules.py#1`
- B (7 skills): credential detection, regular expressions, security scanning, checkov, ec2 userdata validation, imdsv2 compliance, hardcoded secrets detection
- M (5 skills): regular expressions, credential detection, secrets management, security scanning, python
- `=` credential detection, regular expressions, security scanning (3) · `~` hardcoded secrets detection≈secrets management (1) · `x` checkov, ec2 userdata validation, imdsv2 compliance (3)
- **exact 0.43 · semantic 0.57** ← baseline emitted 7, I emitted 5 → 3 "misses" are pure verbosity gap

## Aggregate (these 5 cohesive chunks)
- **Exact recall ≈ 0.53 · Semantic recall ≈ 0.75** — and this is the EASY case
  (all Checkov). The 120-chunk eval averaged 0.30 exact because it includes prose
  + diverse files where two runs agree less, AND its candidate was PACKED (terser).

## Why the score is low — four distinct causes, decomposed

1. **"A chunk's skill set" is underdetermined (the dominant cause, ~floor 0.5–0.75).**
   Each chunk legitimately evidences 6–8 skills; any single extraction *samples*
   ~4–6 of them. Two independent samples overlap ~50% exact / ~75% semantic. This
   is inherent to treating extraction as "produce the set" — it's a sampling
   problem, not a quality defect. An LLM run is a SAMPLE, not ground truth.
2. **Phrasing variance (~20 points, exact→semantic).** "iac scanning" vs
   "infrastructure as code scanning"; "ec2 security" vs "ec2 userdata analysis".
   The semantic metric recovers these — that's the 0.53→0.75 jump.
3. **Granularity / angle (~10–15 points, survives semantic).** "aws autoscaling
   groups" vs "auto scaling group configuration" vs "high availability" — each a
   valid grain of the same evidence; embeddings only partly bridge them.
4. **Verbosity asymmetry (~10 points, amplified by packing).** When the baseline
   emits 7 skills and the candidate 5, 2 are "missed" purely because the candidate
   was terser. **Packing makes the model terser per chunk** → this is the real,
   residual packing degradation, on top of the sampling floor.

## What this means for the verdicts
- The cost-lever recall scores (per-file 0.12, Tier 1 0.16, packing 0.30) were
  measuring **two-sample agreement minus phrasing**, NOT skill quality. They are
  not "70–84% wrong" — they're "this much of one noisy draw matched another".
- The semantic metric helps but **caps ~0.75** even for perfect extractions,
  because causes 1, 3, 4 survive it. So "semantic recall 0.4" is NOT a failure —
  it's near the achievable ceiling for sample-vs-sample.
- **Tier 1 at 0.82 showed zero lift** because canonical-vs-raw pairs sit *below*
  0.82 cosine — the threshold was the bug, not Tier 1. A 0.65 threshold (the
  resolver's own) is the right test.

## The fix (what the score should be measured against)
A single LLM draw can't be the ground truth — comparing two draws caps at ~0.75.
The durable fix is a **golden set**: hand-curate the UNION of valid canonical
skills per chunk (50–100 chunks), then score:
- **precision** = of the candidate's skills, how many are in the golden union
  (are they VALID — this is what actually matters for retrieval/resume);
- **recall** = of the golden union's IMPORTANT skills, how many the candidate found.
This removes the sample-vs-sample ceiling: a candidate is judged against truth,
not against one noisy alternative draw. It makes Tier 1, packing, and every future
taxonomy change measurable. (DeepEval golden-set track — this is its first dataset.)

## Immediate, free
`cache_read_input_tokens: 0` on every call — the static system prompt + tool
schema are re-sent uncached. At any pack size that's a free ~13% off input with
zero quality cost.
