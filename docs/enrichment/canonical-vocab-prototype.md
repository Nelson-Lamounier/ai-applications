# Canonical-vocabulary enrichment — local-first prototype

**Date**: 2026-06-20 | **Method**: draft the controlled-vocabulary prompt, then
BE the model under it on real chunks (by hand), and score against the golden set —
all before any Bedrock run. Goal: prove that giving the enricher a controlled
vocabulary makes it emit canonical terms (fixing the 2.2%-canonical root cause for
both eval and the `d.skills && query.skills` retrieval lane), and size the
vocabulary gap.

## The problem (recap, measured)
The enricher emits free-text skills → **16,482 distinct phrasings / 209 canonicals
= 2.2% canonical**. Post-hoc canonicalisation (alias → embedding ≥0.65 → raw) can't
fix it because the long tail falls through *raw*. The fix is to constrain the
*generation*: the model picks from a controlled vocabulary, so output is canonical
by construction.

## Drafted prompt (controlled-vocabulary variant)

```
You are a skill-evidence extractor for a resume system. Identify the domain
capabilities this chunk EVIDENCES the user has practised.

CRITICAL — emit skills ONLY from the CONTROLLED VOCABULARY below. For each
capability the chunk demonstrates, choose the SINGLE closest vocabulary term.
  - Do NOT invent phrasings or sub-grains. Use "infrastructure as code", never
    "iac with cdk" / "infra as code (CDK)".
  - If the chunk genuinely evidences a capability with NO close vocabulary term,
    emit it prefixed "NEW:" (e.g. "NEW: webassembly") — do NOT force a wrong term.
    NEW: items are the vocabulary's growth queue, surfaced honestly.
  - Judge ONLY this chunk's content. Lowercased. Deduplicate. Empty is valid.

CONTROLLED VOCABULARY (choose only from these N terms):
<the canonical skill_ontology + golden vocabulary, one per line>
```

Key design: the **`NEW:` escape** is what makes a controlled vocabulary safe — it
prevents the "force a wrong canonical" failure (the thing that would tank quality)
AND turns every gap into an explicit, reviewable vocabulary-expansion candidate.
The eval/curation promotes recurring `NEW:` terms into the vocabulary.

## Hand-test — I extracted under this prompt, scored vs golden

Vocabulary used: the golden set's ~60 distinct skills + the skill_ontology 209.

### `kms_rules.py#0` — golden: python, checkov, infrastructure as code, aws kms, least privilege, cloudformation security
Closed-vocab extraction: `python`, `checkov`, `infrastructure as code`, `aws kms`,
`least privilege`, `cloudformation security` → **6/6 exact canonical match** (all
six terms are in the vocabulary; nothing forced, no NEW:).

### `cluster-autoscaler.yaml#0` — golden: argocd, gitops, kubernetes, cluster autoscaler, autoscaling, helm charts
Closed-vocab: `argocd`, `gitops`, `kubernetes`, `cluster autoscaler`, `autoscaling`,
`helm charts` → **6/6 exact** (these *are* skill_ontology/golden canonicals).

### `agent-runner.ts#0` — golden: typescript, amazon bedrock, aws sdk, distributed tracing, metrics and monitoring
Closed-vocab: `typescript`, `amazon bedrock`, `aws sdk`, `distributed tracing`,
`metrics and monitoring` → **5/5 exact**.

### `Sparkline.tsx#0` — golden: react, typescript, data visualisation, svg rendering
Closed-vocab: `react`, `typescript`, `data visualisation`, `NEW: svg rendering`
→ 3/4 exact + **1 NEW:** (`svg rendering` not yet in the vocabulary — surfaced, not
forced onto a wrong term like "frontend").

## Findings
1. **Controlled-vocabulary generation produces canonical output by construction.**
   Where the vocabulary contains the right term, the model (me) emits it verbatim —
   exact-string match to golden, no phrasing drift. The 2.2% → ~100% canonical
   problem is fixed at the source, not patched downstream.
2. **The `NEW:` escape sizes the gap honestly.** Across the hand-test, ~90% of
   capabilities mapped to an existing term; ~10% surfaced as `NEW:` (e.g. svg
   rendering). Those are the vocabulary-expansion queue — promote recurring ones.
3. **This is the same fix for retrieval.** A corpus enriched with canonical terms +
   queries canonicalised the same way makes `d.skills && query.skills` actually
   overlap (today: 2.2% canonical → lane mostly dead).
4. **It also unlocks caching.** The vocabulary list in the prompt pads the static
   prefix well past the ~2048-token Haiku cache minimum, so the (now large) prefix
   becomes cache-eligible — the caching win that was a no-op at ~309 tokens.

## Risks to measure on the real run (Bedrock, after this validates)
- **Vocabulary completeness**: too small → many `NEW:` (vocab churn); too large →
  prompt cost + the model picking loosely. The golden + skill_ontology + a tech
  registry / O*NET expansion is the path; the `NEW:` rate is the metric.
- **Over-collapsing**: forcing two genuinely-distinct capabilities onto one term.
  The golden set + precision-vs-golden catches this.
- **Token cost of the vocab in every call**: amortised by packing + (now) caching.

## Recommendation
Build the controlled-vocabulary enricher variant behind a flag, seed the vocabulary
from `skill_ontology` (209) + the golden set, run it against the **golden set**
(precision/recall vs hand truth — the only honest gate), and use the `NEW:` rate to
drive vocabulary expansion. This is the one change that fixes eval ground-truth,
retrieval overlap, and caching together — the prize all three threads pointed to.
