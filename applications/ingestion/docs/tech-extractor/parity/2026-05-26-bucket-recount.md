# Tech-extractor parity — bucket recount after ReadmeParser v2

**Date:** 2026-05-26
**Image:** `tech-extractor:98e1198…-r1` (post PR #56 wiring + PR #57 dockerfile fix)
**Repos under test:** `Nelson-Lamounier/kubernetes-bootstrap`, `Nelson-Lamounier/tucaken-app`
**Test user:** `e3802934-08de-4d96-a087-d47167d785f8`

## Parity numbers (before vs after ReadmeParser v2)

| Repo | Recall before | Recall after | Δ | L1 canon before → after |
|------|---------------|--------------|---|--------------------------|
| kubernetes-bootstrap | 0.368 | 0.529 | +44% relative | 38 → 52 (+14) |
| tucaken-app          | 0.253 | 0.266 | +5% relative  | 27 → 28 (+1) |

ReadmeParser v2 (mitigations 1+2: prose_safe filter + length floor 4) emitted:

| Repo | Rows | Distinct aliases | Canonicalised | Unresolved |
|------|------|------------------|---------------|------------|
| kubernetes-bootstrap | 106 | 23 | 23 (100%) | 0 |
| tucaken-app          |  22 |  6 |  5 (100%) | 0 |

**FP spot-check (30 random readme rows):** 0 false positives. Every match was a legitimate tech mention. Mitigations 1+2 worked exactly as designed.

## LLM-only residual — bucket distribution (98 canonicals)

Method: for each LLM-only canonical (LLM resolved a token to an ontology id that L1 did not produce evidence for), the LLM's raw token set was greppped against the local repo checkout. File-type distribution then classified into the sharper buckets agreed in the 2026-05-26 framework discussion.

| Bucket | Count | % | Notes |
|--------|-------|---|-------|
| (a) detector miss — appears in yaml/dockerfile/package.json | **59** | **60%** | kbs 37, tuc 22 |
| (c2) code only — TS strings, TSDoc, code comments | 20 | 20% | tuc 20 |
| (c1+c2) mixed code + non-readme .md | 14 | 14% | tuc 14 |
| (c1) pure non-readme .md | 2 | 2% | kbs 2 |
| (c4) other files (.env, json, etc.) | 2 | 2% | kbs 2 |
| (d) hallucination | ~0 | 0% | (the 1 flagged was a false negative — multi-word token vs source's compound-word form) |

Raw classification: `2026-05-26-bucket-recount.csv` (one row per LLM-only canonical with file-type counts).

## Spot-check of bucket (a) — the dominant 60%

Sub-classification by inspecting the actual line content for the highest-volume items:

- KBS `aws_eks` 61 yaml hits: YAML comments (`# Pod Identity prerequisite (CDK — EksPodIdentity stack)`), annotation values (`eks.amazonaws.com/role-arn`), cluster names (`k8s-eks-development`).
- KBS `aws_ecr` 43 yaml hits: YAML comments (`# ECR image exists`), image URIs (`…dkr.ecr.eu-west-1.amazonaws.com/…`).
- TUC `aws_cognito` 67 code hits: TS comments (`// Gate 1: valid Cognito session`), UI strings (`"Secured by AWS Cognito · SOC 2 Type II"`).

Bucket (a) therefore splits further:

- **(a1) genuine structural miss** — the parser is already scanning the file but misses the field (image URIs, ARN strings, annotation keys/values).
- **(a2) prose in structured-file comments** — YAML `#` lines, TS string literals, TSDoc — not reachable via AST parsing, structurally identical to README prose extraction.

The split between (a1) and (a2) is roughly even on KBS sample, heavier on (a2) for TUC's code-heavy repo. Estimating ~30 (a1) + ~29 (a2) across both repos.

## Decision (vs the framework)

The framework's decision criteria:

- **(B) expand prose to *.md** if c1 dominates (>40%). **NOT MET** — c1 is 2-16%.
- **(C) lock in v2.0 + decommission** if c3 dominates OR d ≥25% OR e dominates. **NOT MET** — c3=0, d=0, e=0.

The dominant residual (60% bucket a) is neither prose-extension nor uncloseable cross-repo signal. It is a **third path** the framework didn't anticipate:

**(F) strengthen the L1 IaC + code parsers** to extract canonical names from:
- IaC annotation values, env-var values, image URIs, ARN strings (closes most of a1)
- YAML comments, TS string literals, TSDoc (closes a2; structurally the same problem as ReadmeParser v2 but at finer granularity)

## What this also tells us

- **Hallucination rate is effectively 0%.** Every LLM-only canonical is supported by actual text in the repo. The LLM enricher's residual recall is real signal, not noise. The decommission decision cannot rest on "the LLM is hallucinating" — it must rest on "we can reproduce the signal structurally."
- **The LLM's residual value is "catches things our parsers leak", not "magic prose understanding."** Tightening parsers (F) directly reduces the LLM's incremental value. Decommissioning becomes mechanical once F lands.
- **(B) is not worth shipping standalone.** It closes 2-16% of residual at the cost of a second prose-scan boundary to maintain. If pursued, it should be part of a unified prose-extraction-v3 that also handles (a2) — but (a2) sits closer to (F) than to (B) in spirit (prose lifted out of structured files, not prose at arbitrary depth).

## Recommended sequence

1. **v2.0 is shipped.** (PR #56 merged; this artefact + raw CSV durable.)
2. **Spec for (F)** — IaC + code detector strengthening. Sub-spec breakdown:
   - F1: IaC value-scanner (image URIs, ARNs, annotation values) — touches `parseK8sManifest`, `parseHelmValues`, `parseTerraform`, adds an ARN-aware scanner pass.
   - F2: Code-comment prose scanner — extends the prose extractor to `.ts`/`.py`/`.go` comment ranges using tree-sitter comment nodes (re-uses the prose_safe alias set + length floor).
3. **Defer (B)** explicitly. Document the deferral with the bucket data so it is not re-relitigated.
4. **Decommission gate** — re-run parity after F1+F2 land. Expected: LLM-only drops to <10 canonicals across both repos. At that point decommission is one paragraph: "structural coverage now matches LLM coverage minus a documented carve-out; remove the LLM enricher."

## Future-decision input

The CSV is the audit trail. Each row records: repo, canonical name, file-match counts by type. A future "should we add cross-repo signal?" or "should we extend to .adoc?" question becomes a CSV filter — not a fresh investigation.

Spec to follow: `applications/tech-extractor/specs/2026-05-26-iac-detector-strengthening-design.md`.
