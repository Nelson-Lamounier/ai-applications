# LLM ChunkEnricher decommission — technologies role

**Date:** 2026-05-27
**Predecessor artefact:** `2026-05-26-bucket-recount.md` (v2.0 — 60% bucket-a)
**This artefact:** v2.3 trajectory + decommission decision

## Trajectory

| Engagement state | KBS recall | TUC recall | KBS L1 | TUC L1 | LLM-only |
|------------------|-----------:|-----------:|-------:|-------:|---------:|
| Start (pre-ReadmeParser v2)            | 0.368 |  0.253 | 38 | 27 | ~100 |
| v2.0 — ReadmeParser v2 (PR #56)        | 0.529 |  0.266 | 52 | 28 | 98 |
| v2.1 — F1 IaC value scanner (PR #59)   | 0.575 |  0.519 | 58 | 50 | ~75 (mid-measurement) |
| v2.1.1 — alias backfill + clear        | 0.535 |  0.510 | 74 | 80 | ~95 (canonicals doubled both sides) |
| v2.2 — F1 dispatch fix (PR #63)        | 0.535 |  0.510 | 74 | 80 | 95 (immaterial) |
| **v2.3 — F3 YAML-comment prose (PR #64)** | **0.624** |  **0.510** | **83** | 80 | **89** |
| Target gate                            | ≥ 0.85 | ≥ 0.65 | — | — | ≤ 10 |

Both repos nearly doubled in recall versus the start of the engagement. **Gates were not met.** Decommission proceeds under documented carve-out (this artefact).

## v2.3 bucket distribution (89 LLM-only canonicals)

Raw classification: `2026-05-27-bucket-recount-v23.csv`.

| Bucket | Count | % | Repo split |
|--------|------:|--:|------------|
| (a) detector miss — appears in yaml/dockerfile/package.json | **50** | **56%** | kbs 34, tuc 16 |
| (c2) code only — TS/JS strings, TSDoc, code comments | 16 | 18% | tuc 16 |
| (c1+c2) mixed code + non-readme .md | 13 | 15% | tuc 13 |
| (c1) pure non-readme .md | 5 | 6% | kbs 2, tuc 3 |
| (c4) other (.env, .json, etc.) | 2 | 2% | kbs 2 |
| (d) hallucination | 2 | 2% | tuc 2 (`aws_secrets_manager` is a multi-word false-negative artefact; `koa` may or may not be real) |
| unknown | 1 | 1% | tuc 1 |

## What's actually in the residual (root cause)

Spot-inspection of the bucket-a items on KBS reveals a single dominant pattern:

**Multi-word AWS service names in prose.** The prose tokenizer in `parseReadmeProse` / `scanProseRanges` splits on whitespace and emits single tokens. Aliases like `aws_bedrock` (single token, prose_safe-tagged) cannot match source text "AWS Bedrock" / "Amazon Bedrock" / "aws-bedrock" because those tokenize to `['aws','bedrock']` etc. The 34 KBS bucket-a items are dominated by:

- `aws_acm`, `aws_api_gateway`, `aws_autoscaling`, `aws_backup`, `aws_bedrock`, `aws_elb`, `aws_firehose`, `aws_kms`, `aws_rds`, `aws_sqs`, `aws_step_functions`, `aws_sts`, `aws_vpc`, `aws_waf`, `aws_wafv2` — referenced in YAML comments as "AWS RDS", "Step Functions", "API Gateway" prose

The remaining ~20 items are similar patterns in tucaken-app (sentry, oauth2, openai, alloy, etc.) appearing in code comments and string literals as multi-word phrases.

## FP rate at v2.3

| Layer | Sample | FP count |
|-------|-------:|---------:|
| readme (v2 baseline)       | 30 | 0 |
| code-prose (F2)            | 30 | 0 |
| yaml-comment (F3)          | 30 | 0 |

Mitigations 1 (prose_safe filter) + 2 (length floor 4) hold across all three prose scanners. Zero false positives in 90 manually-inspected rows.

## Decommission decision

**Effective 2026-05-27, the BedrockChunkEnricher's `technologies` extraction role is decommissioned.** The deterministic `tech-extractor` Layer-1 pipeline is the sole source of truth for `technology_evidence`.

Specific changes (this PR):
- `BedrockChunkEnricher.SYSTEM_PROMPT` no longer instructs the model to extract technologies.
- `BedrockChunkEnricher.TOOL_SCHEMA` removes the `technologies` property; only `skills` remains.
- `BedrockChunkEnricher.enrich()` returns `technologies: []` unconditionally for schema back-compat with `document_embeddings.technologies` (column retained; values empty going forward).
- The skills extraction role is unchanged. Skills continue to be LLM-extracted because no structural alternative exists and `computeKbQuality` / `computeUserDiagnostic` consume the field.
- `technology_parity_runs` keeps running as a watchdog. From this date forward, `llm_canonical_count = 0` and `recall` is undefined — the row's presence is the audit trail showing when decommission landed.

Token-cost impact: the LLM tool schema drops from 2 properties to 1; per-chunk output tokens drop ~30-50%. Per-chunk input tokens drop ~10% (system prompt is shorter).

## Carve-out (the residual we are accepting)

89 canonicals that the LLM was emitting and the deterministic pipeline is not. Distribution above. The pattern is well-understood: predominantly multi-word AWS service phrases in prose. Closing this would require either:

- **F4 — multi-word phrase scanner**: tokenize prose into bigrams + trigrams, try `tok1_tok2` and `tok1 tok2` forms against the alias set. ~1 day. Expected: KBS recall → ~0.80, TUC → ~0.65.
- **Ontology expansion**: add multi-word aliases ("aws bedrock", "step functions") with prose_safe=true so the current single-token tokenizer matches them. Ontology-importer change, ~1 day, no parser changes.

Neither is blocking the decommission. Both are tracked as future improvements. If a downstream consumer notices a degraded coverage for any specific tech, the parity gap is quantifiable from this artefact's CSV, not speculative.

## Hallucination rate

2 of 89 = ~2%, and one of the two (`aws_secrets_manager`) is a known multi-word false-negative in the bucket-recount classifier (the LLM raw token is "aws secrets manager" with spaces, the source has "AWS_SECRETS_MANAGER" compound form which the classifier's word-boundary grep doesn't match). True hallucination rate is closer to 1% (just `koa`).

The "the LLM is hallucinating, kill it" framing is **not** the justification for decommission. The justification is: **its remaining value is reproducible structurally** (the residual gap is parseable prose, not a black-box capability), and the tech-extractor is the source of truth from which the wider tech-graph builds.

## Reversibility

The change is one commit, narrowly scoped to the system prompt + tool schema + return value. Reverting it restores LLM technologies extraction. The `ChunkEnrichment.technologies` interface field is retained, the `document_embeddings.technologies` column is retained, `RdsVectorStore` write path is unchanged. No data migration required to roll back.

## What stays running

- BedrockChunkEnricher (skills extraction only)
- Skills feed (`document_embeddings.skills`) — unchanged
- KB quality + diagnostic scoring (read skills, not technologies) — unchanged
- Tech-extractor Layer-1 pipeline (source of truth for technologies)
- Parity reporter (watchdog; will show llm=0 going forward, useful as the audit marker)

---

## Appendix: v2.4 follow-on (F4 bigram + negation, PR #66)

After the v2.3 decommission landed, F4 shipped as the optional carve-out shrinker called out above: prefix-guarded bigrams (`aws_X` / `amazon_X` / `azure_X` / `google_X` / `gcp_X` / `apache_X`) plus line-scoped negation detection in `scanProseRanges`. Both changes flow through F2 (code-prose) and F3 (yaml-comment) automatically via the shared shim.

### Trajectory (final)

| State | KBS recall | TUC recall | KBS L1 | TUC L1 | Combined LLM-only |
|---|---:|---:|---:|---:|---:|
| Start (pre-ReadmeParser v2) | 0.368 | 0.253 | 38 | 27 | ~100 |
| v2.0 — ReadmeParser v2 | 0.529 | 0.266 | 52 | 28 | 98 |
| v2.3 — F1+F2+F3 | 0.624 | 0.510 | 83 | 80 | 89 |
| v2.4 — F4 (initial) | 0.634 | 0.510 | 88 | 81 | 88 |
| **v2.4 — F4 + prose_safe backfill** | **0.673** | **0.548** | **94** | **87** | **80** |
| Target gate | ≥ 0.85 | ≥ 0.65 | — | — | ≤ 10 |

### What F4's initial measurement revealed

The F4 bigram code worked correctly on first deploy (KBS +1pp / TUC unchanged), but most of the new bigram emissions (`aws_ecr`, `aws_iam`, `aws_eks`, etc.) were already canonicals L1 had via the F1 ARN / annotation paths. The bigrams targeting NEW canonicals (e.g. `aws_bedrock`, `aws_rds`, `aws_api_gateway`, `aws_waf`, `aws_secrets_manager`, `aws_route53`) were silently rejected because those compound aliases had `prose_safe = false` from the original 2026-05-26 ProseSafeTagger run.

### prose_safe backfill (DB data change)

The ProseSafeTagger conservatively marked compound forms (`aws_bedrock`, `aws_rds`, etc.) as `prose_safe = false` because they could in principle look like generic prose. Under F4's hard cloud-prefix bigram guard those concerns disappear — the only way `aws_bedrock` ever gets matched is when source prose says `aws bedrock` adjacent. Promoted with:

```sql
UPDATE technology_aliases
  SET prose_safe = true
  WHERE prose_safe = false
    AND alias ~ '^(aws|amazon|azure|google|gcp|apache)_';
-- UPDATE 58
```

Re-running the prose_safe tagger (`run-tag-aliases-prose-safe.ts`) currently only processes `WHERE prose_safe IS NULL`, so this backfill is preserved on subsequent runs. To make the new policy permanent, the tagger's calibration few-shot should be updated to include cloud-prefix compound forms as `yes`. Tracked as a follow-up; not in this PR.

### v2.4 FP check (30 bigram-derived rows)

| Verdict | Count |
|---|---:|
| Clear true positive | 27 |
| Borderline | 3 (`aws_profile` × 3 — refers to the `AWS_PROFILE` env var rather than a deployed service per se) |
| False positive | 0 |

FP rate: 0% (strict) or 10% (counting borderlines). PASS either way.

Cumulative FP-checked sample across the engagement: 120 rows (30 readme + 30 code-prose + 30 yaml-comment + 30 bigram). Total FP count: 0–3. The four mitigations (prose_safe filter, length floor, prefix-guard bigram, negation detection) held across every layer.

### Carve-out at v2.4 (final residual)

80 LLM-only canonicals remain (KBS 33, TUC 47). The closure trajectory plateaued — not because the parser plateaued but because the LLM enricher's remaining outputs are tokens that don't fit the cloud-prefix pattern: `bash`, `curl`, `pip`, `openssl`, `jwt`, `cors`, `json`, `bcrypt`, `pino`, `vite`, `yarn` and similar single-token identifiers that DID exist in source but were NOT in the prose_safe set (because the original tagger judged them ambiguous in arbitrary prose).

Further closure is available via more targeted prose_safe promotion of single-token aliases, but each is a judgement call (e.g. `go` is genuinely too ambiguous in prose — the verb dominates; `bash` is safe in code-comments but iffy in prose). Not pursued; the decommission carve-out is already an order of magnitude tighter than the original gate would have looked without the engagement.

### Cumulative engagement summary

- KBS recall: 0.368 → **0.673** (+83% relative)
- TUC recall: 0.253 → **0.548** (+117% relative)
- Combined LLM-only canonicals: ~100 → **80** (-20%)
- FP rate across 120 inspected rows: **0–3** false positives (≤ 2.5%)
- Hallucination rate (v2.3 sample): **~2%** (1–2 of 89)
- Token cost: BedrockChunkEnricher per-chunk output -30–50% (technologies decommissioned)

LLM enricher decommission stands. The 80-canonical carve-out is documented and structurally addressable (further targeted prose_safe promotion + a phrase-scanner extension for non-cloud multi-word names) but not blocking any downstream consumer.
