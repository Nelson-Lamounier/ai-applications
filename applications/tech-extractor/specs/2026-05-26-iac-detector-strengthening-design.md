# Tech-extractor — IaC + code detector strengthening (parity-closure spec)

**Date:** 2026-05-26
**Status:** Spec — pre-implementation, awaiting approval before plan.
**Driver artefact:** `applications/tech-extractor/parity/2026-05-26-bucket-recount.md`

## Goal

Close ~60% of the remaining L1-vs-LLM parity gap by extending the Layer-1 extractors to capture canonical tech mentions that already appear in files L1 scans, but that L1's current AST/structured passes do not surface. Bring LLM-only canonicals from 41 (kbs) + 57 (tucaken) → <10 across both repos.

This is the work that lets the LLM enricher's decommission decision become mechanical instead of contested.

## Background — why this and not (B) prose-expand

The 2026-05-26 bucket recount classified all 98 LLM-only canonicals across both reference repos. Distribution:

- 60% appear in yaml/dockerfile/package.json — files L1 already reads.
- 34% appear in code (TS strings, TSDoc, comments) — files L1 reads via tree-sitter but only extracts imports from.
- 4% appear only in non-readme markdown or other text files (would be closed by extending parseReadmeProse to `*.md`).
- 0% true hallucinations.

The dominant residual is **not prose at arbitrary depth**. It is **canonical names sitting in fields and comments of files L1 is already scanning, that the current parsers do not surface**. Two flavours:

- **a1 — genuine structural fields the parser misses:** image URIs in `image:` keys, ARN strings, K8s annotation keys/values like `eks.amazonaws.com/role-arn`, env-var values referencing `arn:aws:secretsmanager:...`, ECR registry hostnames.
- **a2 — prose embedded in structured-file comments:** YAML `#` lines, TS string literals, TSDoc blocks. Structurally identical to README prose extraction but reached via a different file-type filter.

## Sub-projects

This spec covers two independent sub-projects. Each produces working, testable software on its own. The plan stage will split them.

### F1 — IaC value scanner

A pass over IaC files (`.yaml`, `.yml`, `.tf`, `.hcl`, `Dockerfile`, Helm `values.yaml`) that extracts canonical tech references from **values** the AST passes ignore today:

- AWS service-arn parser — recognise `arn:aws:<service>:...` strings and emit the resolved canonical (`aws_secretsmanager`, `aws_sns`, `aws_route53`, …). Map AWS service slugs to ontology canonicals via a small static table; unknown slugs go to `raw_name` with `technology_id=null` so the resolver can still try.
- ECR registry-URI parser — `<account>.dkr.ecr.<region>.amazonaws.com/<repo>` → `aws_ecr` plus the repository name as supplementary.
- K8s annotation-value scanner — for any value where the **key** is in a small list of AWS-bound annotation keys (`eks.amazonaws.com/role-arn`, `iam.amazonaws.com/permitted`, `service.beta.kubernetes.io/aws-load-balancer-*`, etc.), the value's content is also scanned for AWS service slugs.
- Image-reference parser — `image: <registry>/<vendor>/<tool>:<tag>` in any pod/container spec, regardless of `kind:`. Already partly handled by `parseHelmValues`; this generalises it to all manifest kinds.

Output is more `RawTechnologyEvidence` rows with `source_layer='iac'` and `ecosystem='aws-arn' | 'image-uri' | 'k8s-annotation'`.

**Scope guardrail:** F1 only emits evidence with `technology_id` set (resolver-canonicalised). Unresolved tokens go through the existing `TechnologyCandidateRepository` flow — no new path needed.

### F2 — Code-comment prose scanner

A pass over `.ts`/`.tsx`/`.py`/`.go` files (and any future tree-sitter language) that:

- Uses the tree-sitter query for comment + string-literal nodes to extract just the prose ranges from each file.
- Feeds those ranges into the existing `parseReadmeProse` engine (same prose_safe alias set, same `minAliasLength`, same dedupe key).
- Emits `source_layer='code-prose'` evidence rows with the file path and line range.

This reuses the prose_safe infrastructure built for ReadmeParser v2. No new mitigation logic. The boundary work is purely "give me the prose ranges from this code file." Tree-sitter already produces an AST with comment nodes — this pass just walks them.

**Scope guardrail:** UI strings are in-scope (caught the `"Secured by AWS Cognito"` case). Import-path strings are out-of-scope (already handled by `TreeSitterExtractor`'s import pass) — F2 must skip string-literal nodes that are children of an import/require declaration.

## Non-goals

- Expanding `parseReadmeProse` to all `*.md`. Closes only 2-16% of residual; deferred until F1+F2 land and the new residual distribution can be re-measured. Documented as a deferral in the bucket recount artefact.
- Cross-repo signal (Helm chart in one repo, values in another). 0% of current residual; not a real concern for this engagement.
- ADR/feature-doc prose at arbitrary depth. Only 2% of residual; would be a v3 if needed.
- Negation detection / context-window scoring (planned v2.1/v2.2). Both deferred until a measured FP increase justifies them. Current FP rate is 0%.

## Architecture choices

- **F1 and F2 share no code.** They operate on different file types via different parser plumbing. The plan stage will produce one PR per sub-project.
- **F1 extends `iacExtractor` as a new internal helper, not as a new top-level Extractor.** Keeps the orchestrator's fault-isolation boundary intact (single iac unit, single fail-counter).
- **F2 extends `TreeSitterExtractor`** rather than registering a separate extractor. It reuses the same tree-sitter parse the import extractor already performs, so there is no double-parse cost.
- **No new ontology aliases are added by this spec.** The recount confirmed the alias coverage is already adequate (every LLM-only canonical resolves cleanly via existing aliases once seen). If future spot-checks surface alias gaps, those go through the standard ontology-importer flow.

## Success criteria

Re-run parity on both reference repos after F1+F2 land:

- KBS: recall ≥ 0.85 (currently 0.529)
- TUC: recall ≥ 0.65 (currently 0.266 — lower bar because of the (a2) code-comment ratio that is partly addressed by F2 but not 100%)
- LLM-only canonicals: ≤ 10 combined across both repos
- FP rate on a 30-row spot-check of new `iac` + `code-prose` evidence: ≤ 10%

If all three pass, the LLM enricher decommission becomes a one-paragraph PR.

If F1+F2 land and KBS+TUC fall short of the above, the next decision is **B + ADR-style negation** rather than further parser strengthening — at that point we are extracting structural and code-comment signal as well as a deterministic system reasonably can.

## Test strategy

Standard TDD. F1 ships with:

- Unit tests for the ARN parser (per AWS service: secretsmanager, sns, sqs, rds, s3, route53, kms, ecr, eks, ec2, vpc, iam, sts, cognito, lambda, cloudfront, cloudtrail, step-functions, kinesis, firehose, dynamodb, textract, cost-explorer, waf, backup, autoscaling, api-gateway, acm, bedrock) — happy path + malformed ARN + cross-region ARN.
- Unit tests for ECR image URI parsing.
- Unit tests for K8s annotation-value extraction against a fixture manifest containing each of the AWS-bound annotation keys above.
- An integration test that runs `parseK8sManifest` + the new value-scanner over a fixture chart (mini-version of platform-rds or ingestion chart) and asserts the union of emitted canonicals matches a frozen expected set.

F2 ships with:

- Unit tests for the comment + string-literal extraction query (per language: ts, py, go).
- Unit tests for the import-string-literal exclusion (must not double-emit imports).
- An integration test running F2 over a fixture TS file containing a UI string (`"Secured by AWS Cognito"`), a TSDoc block mentioning a tech, and an import statement — asserting only the first two produce evidence.

Re-measurement on the two reference repos is a smoke test, not a unit-test gate.

## Risks

- **ARN parsing collisions with sample/example values.** Mitigation: only emit when the ARN has a non-placeholder account id (12 digits, not all zeros, not `123456789012`).
- **F2 doubling counts when a tech is mentioned in both a TSDoc and an actual import.** Mitigation: emit at deduped (canonical x file) granularity; the evidence-repo unique index already handles within-file collapse.
- **K8s annotation-key allowlist drift.** New AWS service annotations land regularly. Mitigation: a unit test that asserts the allowlist file matches a documented snapshot — drift is loud, not silent.
- **(a2) prose in YAML comments is not addressed by F1.** F2 also only covers code-language tree-sitter comments, not YAML `#` lines. There is a residual third sub-project (F3 — YAML comment prose) that closes the remaining ~15% of residual. F3 is out-of-scope for this spec but called out so it is not forgotten in the recount carve-out.

## Sequence after approval

1. Brainstorm (this spec) → approved.
2. Writing-plans → produces `docs/superpowers/plans/2026-05-26-iac-detector-strengthening.md` with F1 and F2 as two top-level task groups.
3. Subagent-driven-development per plan.
4. Re-measure parity on both reference repos.
5. Update `parity/2026-05-26-bucket-recount.md` with the post-F numbers, then make the decommission decision.

## Out-of-scope follow-ups (documented carve-outs)

- **F3 — YAML/HCL comment prose extraction.** Closes the (a2) sub-bucket inside iac files. Defer until F1+F2 land and the residual is re-measured.
- **B — `*.md` prose expansion.** Defer indefinitely unless re-measurement after F1+F2 shows c1 has grown. Currently 2%.
- **LLM enricher decommission.** Conditional on success criteria above. One paragraph, one PR.
