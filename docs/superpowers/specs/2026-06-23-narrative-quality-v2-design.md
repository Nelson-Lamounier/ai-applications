# Narrative Quality v2 — company bridge, readability, plain-language outcomes

- **Date:** 2026-06-23
- **Status:** Design approved, awaiting spec review
- **Repo:** ai-applications / job-strategist
- **Branch:** `spec/narrative-quality-v2` (off develop; the prior cost/experience/cover-letter stack is merged)

## Problem

Live free (`c893ef33`) + paid (`d6f89fa0`) Wiz runs confirmed the hard problems are
fixed (challenge-led, grounded, no Azure/GCP fabrication, cost recorded, ≤5
bullets/role). The next tier of quality has three gaps, all traced to the persona
not using data it already receives:

1. **No bridge to the company's product/customer reality.** Both letters prove the
   candidate is an excellent AWS engineer but never name what the company's product
   *does* or connect the candidate's skills to operating it / supporting its
   customers. The JD signal already carries the material — `companyProblem` (Wiz =
   Google-backed CNAPP, 230B+ files/day, 50%+ of the Fortune 100) and
   `jdSignal.concepts` (`CSPM`, `Runtime security`, `Threat detection`,
   `Multi-cloud integration`, `Container/Kubernetes security`) — and the free
   writer already receives `<jd_concepts>` (added in PR #328). The persona just
   never tells it to bridge.
2. **Jargon-dense, outcome-thin bullets + under-used metrics.** Experience/project
   bullets read context-free to a non-expert screener ("canonical skills",
   "half-corpus enrichment", "1,964+ chunks"). Meanwhile grounded metrics that DO
   exist in the data are under-surfaced — a highlight literally says *"skills
   overlap lifted from 2.2% to full operation"*. The model also will not invent a
   `%` (correctly — the anti-hallucination gate blocks ungrounded numbers), so
   bullets lack quantified "so what".
3. **Readability + format.** Several sentences are ~60-70-word comma-splices
   (e.g. the paid P2 EKS sentence, the free P2 Rerank sentence). Both greetings are
   `"Dear Hiring Manager"` with no comma.

## Goals

- **Pillar 1 (cover letter):** every letter bridges to the company's product +
  customer reality (grounded in `<jd_concepts>` + `companyProblem`), translates an
  unevidenced JD domain (e.g. multi-cloud) to a transferable strength instead of
  omitting, keeps sentences readable, and is correctly formatted.
- **Pillar 2 (both surfaces):** experience/project bullets AND cover-letter beats
  lead with a plain-language outcome, surface the grounded metrics that exist, and
  express derived magnitude as words — **without** re-opening any fabrication path.
- Eval both pillars (mostly deterministic).

## Non-goals

- No new data source / company-research agent (use the JD signal already fed).
- No change to the anti-hallucination gate (it stays strict; that is what prevents
  invented `%`). No schema/DB migration.
- The cover-letter **header block order** (candidate details → date → company/role)
  is rendered by the frontend/PDF template in `tucaken-app`, not the generator (the
  generator emits only `greeting`/`paragraphs`/`signoff`). Tracked as a separate
  `tucaken-app` fix; out of scope here.
- Resume bullet *count* discipline (handled in PR #333) — unchanged.

## Design

Persona-led, with deterministic guard + eval. The grounding gate is untouched.

### Pillar 1 — cover-letter company bridge + readability + format

**1a. Company/product bridge beat (both personas, prompt-only).** Add a required
beat to the cover-letter contract: name what the company's product does — drawn
from `<jd_concepts>` + `companyProblem` — and translate one of the candidate's
evidenced strengths into operating that product / supporting its customers. E.g.
"the cloud-security-graph reasoning I do natively in AWS is what your customers
need to operationalise across multi-cloud estates." Grounded in the JD signal; no
new data. (Free already receives `<jd_concepts>`; confirm the paid strategist
message surfaces the JD concepts/`companyProblem` to the writer — it carries the
research brief + JD; if concepts are not present, add a compact concepts line to
`buildStrategistMessage` — a prompt-context add, no new LLM call.)

**1b. Multi-cloud / domain transferable-translation (both personas).** Strengthen
the existing transferable rule: when a JD domain exceeds the evidence (e.g.
multi-cloud vs AWS-only), ACTIVELY translate the transferable strength into the
role's need; do not merely omit. Still grounded; never name the gap or claim the
missing skill (the `forward_looking_skill_claim` guard remains the backstop).

**1c. Readability (persona + deterministic guard).** Persona: keep sentences to
1-2 lines; split comma-joined independent clauses; prefer a period or em-dash over
a comma-splice. Guard: add a `long_sentence` violation to `cover-letter-guard`
when any sentence in the body exceeds **40 words** (the existing fail-open Haiku
rewrite then tightens it).

**1d. Density + AI-tie (persona).** Concision over density; reinvest cut space in
company-fit. Keep the AI/Bedrock material (JD-relevant — `agentic workflows`,
`RAG architectures`, `AI-driven automation` are JD concepts) but compressed and
tied to the JD's stated AI-support need.

**1e. Greeting format (persona + guard).** Greeting must end with a comma
(`"Dear Hiring Manager,"`). Guard: add a `greeting_format` violation when the
greeting is non-empty and does not end with `,`.

### Pillar 2 — plain-language outcomes + grounded/derived metrics

Applies to the free writer's experience/project bullets + cover-letter beats, and
the paid strategist's equivalents (prompt-only in both personas).

**2a. Lead with the plain-language outcome.** Each bullet/beat opens with the
outcome a non-expert screener parses, then the technical specifics in support.
Translate niche jargon into plain language (e.g. "half-corpus enrichment" →
"large repos were left with half their skills missing"). Keep the precise term in a
trailing clause if it adds credibility, not as the lead.

**2b. Surface the grounded metrics that exist.** Aggressively use the real numbers
present in the evidence (counts, durations, the real `2.2%`, `1,964 chunks`,
`15→30 min`) — do not drop them. These are already grounded, so the gate passes.

**2c. Derive magnitude as words.** When a magnitude is computable from two source
numbers, express it as a WORD (doubled, halved, eliminated, cut by half) shown
alongside the source numbers — NOT as a coined numeric `%`. A literal `%` appears
ONLY when the `%` itself is in the source (e.g. `2.2%`). This is deliberate: a
derived word passes the metric-grounding gate; a coined number (e.g. "100%"
derived from 15→30) would be flagged as ungrounded — so we steer to words. A
business-impact `%` (e.g. "cut cost 40%") appears ONLY if the data measured it;
otherwise plain-language outcome + the real counts.

The anti-hallucination gate (`gradeFreeResume` metric grounding, resume guard)
is unchanged and remains the safety control.

### Eval (per CLAUDE.md)

Extend `free-resume-writer.eval.test.ts` (+ guard unit tests). Mostly deterministic:
- **Bridge present:** the cover letter contains ≥1 token from `<jd_concepts>`
  (the company/product surface) — given a JD whose concepts include e.g. "CSPM".
- **Readability:** no body sentence exceeds 40 words (`long_sentence` not raised on
  a good fixture; raised on a planted 60-word sentence).
- **Greeting format:** a greeting without a trailing comma raises `greeting_format`;
  with the comma it does not.
- **Plain-language + metric (Pillar 2):** a good fixture leads bullets with a
  plain-language outcome AND surfaces a grounded metric from the evidence; assert a
  grounded number (e.g. `2.2`) appears and `gradeFreeResume` passes. A coined %
  not in evidence still fails the gate (regression of the existing rule).
- **One LLM-judge assertion** (optional, gated): "is this bullet parseable by a
  non-expert screener?" over the good fixture — using the eval's existing judge
  pattern; skip if no judge harness is wired (deterministic checks are the floor).

## Architecture / data flow (unchanged except persona + guard)

```
JD signal: companyProblem + concepts ──► (free) <jd_concepts> envelope [already wired]
                                         (paid) buildStrategistMessage concepts line [add if absent]
        ▼
persona: challenge-led arc + COMPANY BRIDGE beat + transferable-translation
         + plain-language-outcome + grounded/derived-metric + readability
        ▼
writer → { resume, coverLetter }
        ▼
cover-letter-guard: + long_sentence (>40w) + greeting_format  → fail-open Haiku rewrite
gradeFreeResume: metric grounding UNCHANGED (blocks invented numbers)
```

## Error handling
- All persona changes are additive prompt text; no code path depends on the old
  wording. New guard violations route through the existing fail-open rewrite (if
  the rewrite fails, the original is kept and the violation is recorded as a metric).
- If the paid message lacks JD concepts, the added concepts line is conditional
  (omitted when empty) — no behaviour change for JDs without extracted concepts.

## Testing
- **Unit:** `cover-letter-guard` `long_sentence` (fires >40w, not on short) +
  `greeting_format` (fires without comma, not with); confirm neither false-fires on
  a clean good letter.
- **Eval:** the Pillar 1 + Pillar 2 assertions above.
- **Manual:** a fresh free + paid Wiz run shows a product-bridge sentence (names
  CSPM/multi-cloud), readable sentences, plain-language bullet outcomes with the
  grounded `2.2%`/counts, a comma after the greeting, and no invented `%`.

## Acceptance criteria
- Both cover letters bridge to the company's product/customer reality using the JD
  concepts; an unevidenced JD domain is transferably translated, never omitted-only
  or fabricated.
- No body sentence exceeds 40 words; greeting ends with a comma (deterministic).
- Bullets/beats lead with a plain-language outcome and surface grounded metrics;
  derived magnitude is expressed as words; no invented `%` (gate unchanged, eval-proven).
- No new LLM call; no migration; ESLint + typecheck clean; eval green.

## Risks & mitigations
- **Bridge beat invites company flattery / unverifiable product claims:** scope it
  to the JD-supplied concepts/`companyProblem` only ("name what the JD says the
  product does"); the persona forbids inventing company facts beyond the JD signal.
- **40-word guard false-positives on a legitimately long-but-clear sentence:** the
  rewrite is fail-open and only tightens; the threshold is generous (40), and the
  eval asserts a clean good letter does not trip it.
- **Plain-language rule dilutes credibility / drops the precise term:** the persona
  keeps the precise term as a trailing clause, not removed — outcome leads, specifics
  support.
- **Derived-magnitude words slip toward coined numbers:** the persona explicitly
  steers to words (doubled/halved) and the metric-grounding gate still flags any
  coined number, so a regression is caught by the existing eval.
