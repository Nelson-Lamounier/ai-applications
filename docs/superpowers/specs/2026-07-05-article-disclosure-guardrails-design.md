# Article Disclosure Guardrails — Design & Plan

- **Date:** 2026-07-05
- **Repo:** `ai-applications` (article-pipeline)
- **Status:** Approved design; ready to plan
- **Trigger:** The published article *"Eliminating AWS Credentials from a Public
  Next.js Pod: The In-Cluster BFF Migration"* leaked internal network topology
  and a public hostname, and asserted a **false** security property
  ("the BFF and its secrets stay off the public surface" while
  `api.nelsonlamounier.com` was in fact publicly serving the BFF).

## Problem

The article generator can publish material that (a) maps the real attack
surface, (b) claims a protection that is not grounded in the KB or not true, or
(c) spells out an exploitable mechanism. The BFF article did all three. Root
causes, located in the prompt/lint chain:

| Leak in the article | Why it got through |
| --- | --- |
| `api.nelsonlamounier.com`, `public-api.public-api:3001` in prose + Mermaid | `OPERATIONAL IDENTIFIERS` (writer-core-prompt.ts) lists only cluster/namespace/ARN/SSM — **not** public hostnames or service-DNS:port. The deterministic `checkIdentifierLeaks` lint has the same blind spot. |
| Mermaid used the real host | `blog-persona.ts:831` (KB-Augmented) tells the Writer to "use the real resource names and identifiers found there", directly contradicting the identifier rule. |
| "off the public surface" (false) | No rule forces a security-posture claim to be KB-grounded and true; nothing distinguishes "what the code does" from "what an attacker cannot do". |
| XFF rate-limit bypass explained | No rule discourages publishing step-by-step bypass/auth/rate-limit internals. |

## Goals

1. Stop the three leak classes (concrete reachable identifiers, ungrounded/false
   security claims, exploit how-to) **without** gutting the blog's ability to
   describe architecture — it is a portfolio showcase.
2. Enforce primarily with a **deterministic** gate (regex lint), backed by
   Writer-prompt discipline and an independent QA dimension. Defense in depth,
   not prompt-only.
3. Keep one consistent redaction mechanism: the existing `publishIdentifiers`
   allow-list.

## Non-goals

- Blanket ban on describing architecture, patterns, or decisions (the blog's
  value). Only *concrete reachable identifiers* and *exploit detail* are gated.
- Re-architecting the pipeline stages, models, or the brief schema.
- Retroactively re-scanning previously published articles (out of scope; the one
  offending article is fixed by hand as the golden example — see Validation).

## Locked decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| Redaction model | **Extend the `publishIdentifiers` allow-list** to govern the new identifier classes; default = generalise to a placeholder | One mechanism already plumbed end-to-end (research → writer → prompt-assembler → lint); architecture stays describable |
| Primary enforcement | **Deterministic lint** (`checkIdentifierLeaks`) is the hard gate | Regex can't be talked out of it, unlike an LLM instruction that already failed once |
| Security-claim truth | Regex **routes**, does not judge | Truth of "off the public surface" is not regexable; a heuristic linter flags it `warn` and QA/human adjudicates |
| QA enforcement | **New 7th dimension "Security & Disclosure" + hard reject gate** | A disclosure error is worse than a broad-overview; it should force `reject`, not just `revise` |
| Disclosure lint errors | **Block publish** (feed the QA reject gate) | Today structural-lint errors are only metered/logged; a confirmed leak must stop the publish |

## Architecture — three enforcement layers

Execution order left-to-right; the deterministic lint is the **primary** control,
the other two reduce how often it must fire and catch what regex cannot.

```text
Writer (prompt discipline)  ──►  Structured lint (deterministic gate)  ──►  QA agent (independent dimension + hard gate)
  soft: reduces how often          PRIMARY: hard regex gate +                 semantic backstop: catches leaks
  the lint has to fire             publishIdentifiers allow-list              regex can't (false claims, how-to)
```

The section headings below are grouped by control, not execution order.

### Layer 1 — Deterministic lint · `applications/article-pipeline/src/lint/article-lint-rules.ts`

Extend `checkIdentifierLeaks(source, allowlist)` with new patterns, all honouring
the `publishIdentifiers` allow-list (`allowlist.some(a => value.includes(a))`):

- **public hostname** — the owner's domains (`\b[a-z0-9-]+\.nelsonlamounier\.com\b`)
  plus a generic public-FQDN pattern, excluding documented example domains
  (`example.com`, `example.org`).
- **k8s service-DNS:port** — `\b[a-z0-9-]+\.[a-z0-9-]+:\d{2,5}\b` and
  `*.svc.cluster.local`.
- **private IP / CIDR** — `10.x`, `172.(16–31).x`, `192.168.x`, with optional
  `/8`–`/32`.
- **AWS network resource IDs** — `sg-`, `vpc-`, `subnet-`, `eni-` + hex.

Add a sibling `checkSecurityClaims(source)` (severity `warn`, prose-only): flag
assertions of a protection ("off the public surface", "not reachable",
"cannot be accessed", "no credentials", "impossible to") so they are routed to
QA/human review rather than trusted. This rule **detects and routes**; it never
asserts truth.

Wire both into `lintArticle`. In `run-pipeline.ts::lintArticleStructure`, treat
`identifier-leak:*` findings as **publish-blocking** (surface to the QA reject
gate / fail the structural stage), not merely metered.

New unit tests: each new pattern (positive + allow-listed negative), the
example-domain exclusion, and the security-claim router.

### Layer 2 — Writer prompt · `writer-core-prompt.ts` + `blog-persona.ts`

- **Widen `OPERATIONAL IDENTIFIERS`** (writer-core-prompt.ts) to enumerate the
  new classes (public hostnames, service-DNS:port, private IPs/CIDRs,
  sg/vpc/subnet/eni IDs) under the same allow-list rule and placeholder
  convention (`<bff-host>`, `<service>.<namespace>:<port>`, `<cidr>`, `<sg-id>`).
- **Add SECURITY-CLAIM DISCIPLINE** (writer-core-prompt.ts, universal cached
  layer):
  - State a protection **only** if a KB passage explicitly supports it; cite the
    mechanism, not a guarantee.
  - Describe what the code **does**; never assert what an attacker **cannot** do
    ("off the public surface", "unreachable", "impossible").
  - Never publish step-by-step bypass, rate-limit, or auth internals.
  - If the KB is silent or self-contradictory on a security property, **omit**
    the claim.
- **Fix `blog-persona.ts:831`** (KB-Augmented Mermaid instruction): change
  "use the real resource names and identifiers found there" to defer to the
  identifier rule — real *names* for architecture, but any identifier not in
  `publishIdentifiers` is generalised.

### Layer 3 — QA persona · `qa-persona.ts`

- Add dimension **7. Security & Disclosure**. Checks, each severity `error`:
  - a real hostname / service-DNS:port / IP / network-resource-ID in prose that
    is **not** in `publishIdentifiers`;
  - a security-posture claim not grounded in the provided KB/brief, or that
    asserts an attacker limitation rather than a code behaviour;
  - step-by-step bypass / attack / rate-limit-defeat detail.
- **Hard gate:** any Security & Disclosure `error` ⇒ `recommendation: "reject"`,
  regardless of `overallScore` (mirrors the Specificity gate, but stronger).
- **Rebalance weights to 100:** Technical Accuracy 25, Specificity & Result 20,
  **Security & Disclosure 15**, SEO 13, Content Quality 12, MDX Structure 8,
  Metadata Quality 7. Update the Output Format example and Scoring Rules.

## Validation methodology — the live article as the golden example

The published BFF article is the regression fixture. The refactor proceeds
**iteratively, one change at a time**, using it as ground truth:

1. **Change in place.** For each guardrail (e.g. generalise the hostname; remove
   the false "public surface" claim; soften the XFF how-to), edit the published
   article's `content_md` **in RDS** (db `tucaken`, `articles` row
   `slug = retire-all-direct-aws-data-plane-calls-become-a-pure-bff-consumer`)
   via the SSM tunnel. Show the before/after diff.
2. **User approves** the in-place edit.
3. **Encode upstream.** Only after approval, translate that exact change into the
   corresponding prompt/lint rule (Layer 1/2/3) so any *future* article gets it
   automatically.
4. **Prove it generalises.** Add the approved before/after as a fixture to the
   pipeline's golden set (`src/evals/golden*.ts` / a lint fixture) so the rule is
   regression-tested, and confirm the extended lint flags the original (bad) text
   and passes the corrected text.

This makes the fix concrete (a real article visibly corrected) and durable (the
same correction encoded in the generator + a regression test). Order: fix the
artefact → get approval → generalise into the prompt/lint → lock with a test.

### Safety for the in-place RDS edits

- Dev account only (`771826808455`), db `tucaken`, via the SSM port-forward
  runbook (`k8s-dev-platform-rds/credentials`).
- Edits are scoped to the single article row by `slug` + `author_id`; capture the
  original `content_md` before each write so any edit is reversible.
- These are content edits (`content_md`), not schema changes.

## Verification

- ai-applications: Jest per-workspace + typecheck (build `shared` first).
- New lint unit tests pass; the extended lint flags the original BFF-article text
  and passes the hand-corrected version.
- QA persona: the 7-dimension weights sum to 100; a seeded leak/false-claim
  fixture yields `recommendation: "reject"`.
- End-to-end: re-run (or dry-run) generation for the BFF topic and confirm no
  `identifier-leak:*` errors and no ungrounded security claim survive.

## Build order

1. Layer 1 lint (patterns + security-claim router + tests) — the hard gate first.
2. Wire disclosure lint errors to block publish in `run-pipeline.ts`.
3. Layer 2 Writer prompt (identifier widening + security-claim discipline +
   blog-persona:831 fix).
4. Layer 3 QA dimension + gate + weight rebalance.
5. Golden fixture from the corrected BFF article; regression test.
6. Iterate the live article in place per change (Validation), approve, generalise.

## Risks & mitigations

- **False positives** (generic FQDN / `svc:port` patterns hitting legitimate
  prose, e.g. `example.com`, `localhost:3000`): exclude documented example
  domains and `localhost`; allow-list escape hatch via `publishIdentifiers`.
- **Weight rebalance shifts scores** on existing golden evals: re-baseline the
  golden QA scores in the same PR.
- **Prompt-cache invalidation:** the Writer core is Bedrock-cached; editing it
  busts the cache once (expected, one-off cost).
- **Over-redaction reduces "Specificity & Result" concreteness:** the allow-list
  lets deliberately-cleared identifiers through, preserving real config values
  where the author opts in.
```
