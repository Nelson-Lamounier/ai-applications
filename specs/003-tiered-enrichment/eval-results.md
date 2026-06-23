# Eval Results: Tiered Enrichment

**Date**: 2026-06-19 | **Job**: `tier1-eval` on dev | **Sample**: Nelson-Lamounier/tucaken-infra, 150 chunks (all carrying `file_tech_stack`) / 47 files

## Tier 1 (deterministic file_tech_stack → skills) vs per-chunk LLM baseline

| Metric | Value | Meaning |
|---|---|---|
| Recall | **0.163** | Tier 1 captures only 16% of the LLM's skills |
| Precision | **0.518** | half of Tier 1's skills also emitted by the LLM |
| dropped (LLM-only) | **804** | skills the LLM found that Tier 1 missed |
| added (Tier1-only) | 245 | tech-implied skills the LLM didn't emit |
| coverage | 0.953 | Tier 1 fires on 95% of file-tech chunks |
| map size | 49 techs / 75 mappings | |

**Verdict: Tier 1 CANNOT replace the LLM.** Gating the LLM with Tier 1 loses ~84%
of skills (recall 0.16) — the same failure as the per-file lever in feature 002
(recall 0.12), for the same reason: the LLM's value is per-chunk semantic
judgement that deterministic tech-mapping cannot reproduce. `ENRICH_TIER1` stays
OFF as a gate (it ships off by default; PR #297 merged for the substrate + the
eval, not to enable it).

## The consistent lesson (across feature 002 + 003)
You cannot cheapen enrichment by **avoiding** the LLM (per-file, per-tech both
fail recall) — only by **amortising** it. The skills the LLM emits are not
mechanically derivable from a file's technologies; that non-derivable per-chunk
inference is exactly what's worth paying for.

## Recall-preserving cost levers (the pivot — the operator's "floor")
Cut the cost of the LLM call WITHOUT changing what it produces (no eval gate
needed for the call-shape changes — same inputs, same outputs, fewer/cheaper calls):
- **Pack multiple chunks per call** — the ~700-token system prompt is re-sent
  3,932×/repo and dominates the ~$5.90; packing ~N chunks per call amortises it.
- **Content-hash dedup cache** — identical content computes once.
- **Bedrock batch** — ~50% on the calls that remain (async; fits a deferred pass).
- **Prompt caching** — only if the cached prefix clears the model's ≥4,096-token
  minimum (verify for claude-haiku-4-5 in eu-west-1; our bare prompt is ~700).

Target with the floor levers: ~$5.90 → ~$1.50–2.00, **zero quality change**.

## Tier 1's residual value (optional, NOT a cost lever)
Tier 1 could run as an ADDITIVE complement — contributing the 245 tech-cited
skills the LLM missed — improving overall recall. That is a quality change with
its own precision judgement (precision 0.52 means ~half its additions are not
LLM-confirmed), independent of cost. Deferred.
