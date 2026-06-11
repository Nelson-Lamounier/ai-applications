# ATS keyword-coverage v2 — design

**Date:** 2026-06-11
**Status:** Approved (design) — pending plan
**Repo:** `ai-applications` (job-strategist ATS check)
**Branch:** `feat/ats-keyword-v2` (off develop)

## Problem

ATS keyword coverage scored **2/15** on a well-tailored resume. Root cause (confirmed
from a live run): `collectJdMustHaves` takes `research.hardRequirements[].skill`
verbatim — which for this JD were requirement **sentences** ("Critical thinking and root
cause analysis", "Python scripting", "Scripting and code automation capabilities (Python,
similar)") — and matches them as **literal case-insensitive substrings**. The resume
genuinely contains Python, root-cause analysis, automation, troubleshooting, but as
atomic terms, so the phrase-substring match fails. Only atomic "AWS"/"AWS CLI" matched.
~8 of the 13 misses were matcher artifacts; ~5 were genuine gaps.

## Goal

A **true, synonym-credited** keyword coverage that is **scalable for any JD/user** —
nothing hardcoded. Atomic keyword source + a 3-tier match (normalized literal → ontology
synonym → embedding-semantic). Honest: a term is "present" only with real textual or
semantic support; `grounded` still flags KB evidence.

## Source — atomic, JD-agnostic

`collectJdMustHaves(jdExtraction, research)`:
- Prefer the **JD-extractor's atomic terms** (`jdExtraction.requiredSkills` +
  `jdExtraction.tools` + `jdExtraction.concepts`) — atomic by construction, produced for
  every JD. Dedup case-insensitively, drop empties, cap at **18**.
- **Fallback** (jdExtraction empty/absent): the v1 source (hardRequirements skill + infra
  + tools), but each phrase **tokenised** to atomic terms via `normalizeTerm`.

## Match — 3 tiers (per term, against the rendered resume text)

`matchTerm(term, resumeText, ctx): { present: boolean; tier: 'literal'|'normalized'|'ontology'|'embedding'|'none' }`

1. **Normalized literal** (free, deterministic, general):
   - `normalizeTerm(t)` = lowercase → strip QUALIFIER stopwords
     (`expert-level, expert, strong, advanced, solid, proven, excellent, skills, skill,
     capabilities, capability, experience, knowledge, proficiency, ability, hands-on,
     similar, etc, implied, e.g., i.e.`) → replace non-alphanumerics with space → collapse
     spaces → trim.
   - **present** if the normalized term is a substring of the normalized resume, OR every
     content token of the normalized term appears in the normalized resume (token-subset —
     handles "Python scripting"→python present; "root cause analysis"→all tokens present).
   - tier `'literal'` if the raw term matched as-is (v1 parity), else `'normalized'`.
2. **Ontology synonym** (free, deterministic, grows with the self-bootstrapping ontology):
   - `ctx.familyVocab: string[][]` = the vocabulary lists of the resume's **resolved role
     families** (each list is a curated synonym group). For `term`, find a family group
     whose vocabulary contains `term` (normalized). If found AND the resume contains any
     OTHER normalized term from that same group → **present**, tier `'ontology'`. (The
     candidate demonstrably works in that role family, so the family-aligned JD term is
     credited — conservative: requires real family-vocabulary presence in the resume.)
3. **Embedding semantic** (small cost, fully general — independent of ontology coverage):
   - Embed `term` and compare cosine to the resume text via `ctx.embedder`
     (`TitanEmbeddingProvider`). Embed the resume ONCE per run (cache the vector); embed
     each unmatched term. **present** if cosine ≥ `ATS_KEYWORD_EMBED_THRESHOLD` (default
     **0.55**, conservative). tier `'embedding'`.
   - Only tiers 1-2 misses reach tier 3 (cost control). Fail-open: any embed error →
     skip tier 3 for that term (no false credit).

Result per term: `{ term, present, grounded, tier }` (the schema gains `tier` — additive).

## Wiring

- `run-ats-check.ts` `renderCheckAndStoreAts` (and `runAtsCheck`/`checks.ts`) gain:
  `jdExtraction` (atomic source), `familyVocab: string[][]` (resolved-family vocab), and
  `embedder` (TitanEmbeddingProvider, fail-open). Thread from `run-pipeline`.
- `run-pipeline` already computes the resolved families (currently inlined into
  `formatRoleEvidence`). **Capture** `resolved` as a variable; derive
  `familyVocab = resolved.map(r => r.family?.vocabulary ?? []).filter(v => v.length)`; pass
  `jdExtraction`, `familyVocab`, the shared `embedder` to the ATS check.
- `AtsKeywordCoverageSchema` gains `tier: z.enum([...]).default('none')` (additive,
  back-compat — old rows have no tier).

## Honesty
- A term is `present` only with real support: literal/normalized token presence, a
  demonstrated family vocabulary, or a conservative semantic match — never fabricated.
- The `tier` field makes every credit auditable (you can see literal vs embedding).
- The embedding threshold is conservative (0.55) + tunable via env; tier 3 only runs on
  tiers 1-2 misses.

## Scalability (the explicit requirement)
- **Source** = the JD-extractor (runs on every JD) → atomic terms for ANY JD.
- **Tier 1** (normalization/token) = deterministic, language-general, no config.
- **Tier 2** = scales with the self-bootstrapping role ontology (any role, growing).
- **Tier 3** = embeddings → fully general, independent of ontology coverage.
- Degrades gracefully — never worse than v1's literal match; better wherever
  normalization/ontology/embeddings have signal. No per-JD or per-user hardcoding.

## Out of scope
- Changing the ATS pass/fail thresholds or the `deriveIssues` logic (only the coverage
  computation improves; a separate tuning pass can revisit thresholds once coverage is true).
- Research-agent emitting atomic `hardRequirements.skill` — a complementary prompt nudge,
  deferred (the JD-extractor atomic source already fixes the ATS input).

## File list
- `applications/job-strategist/src/ats/jd-keywords.ts` — atomic `collectJdMustHaves` v2 + `normalizeTerm`.
- `applications/job-strategist/src/ats/keyword-match.ts` (new) — `matchTerm` (3 tiers) + `normalizeTerm` (or co-locate in jd-keywords).
- `applications/job-strategist/src/ats/checks.ts` — use `matchTerm`; coverage carries `tier`.
- `applications/job-strategist/src/ats/ats-check.schema.ts` — `tier` on the coverage schema.
- `applications/job-strategist/src/ats/run-ats-check.ts` — thread jdExtraction + familyVocab + embedder.
- `applications/job-strategist/src/run-pipeline.ts` — capture `resolved`, derive familyVocab, pass to the ATS check.
- tests for each.
