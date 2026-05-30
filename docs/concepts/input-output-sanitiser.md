---
title: Input / output sanitisers
type: concept
tags: [security, prompt-injection, redaction, bedrock, defence-in-depth]
sources:
  - applications/shared/src/security/input-sanitiser.ts
  - applications/shared/src/security/output-sanitiser.ts
  - applications/shared/src/security/types.ts
created: 2026-05-27
updated: 2026-05-27
---

## Overview

`InputSanitiser` and `OutputSanitiser` sit on either side of every
Bedrock invocation in the chatbot Lambdas — Layer 2 (input guard)
and Layer 5 (output filter) of the
[six-layer defence-in-depth model](bedrock-rag-surface.md). They are
deliberately **separate** from the
[PiiScrubber](pii-scrubber.md) (which handles PII redaction) and the
[Bedrock Guardrail](bedrock-rag-surface.md#guardrail-five-content-filters-topic-denial)
(model-side filtering): each guards a different concern at a
different layer.

| Sanitiser | Layer | Guards against |
| :- | :- | :- |
| `InputSanitiser` | 2 (pre-Bedrock) | Prompt-injection patterns, length abuse, content the Guardrail would block anyway |
| `OutputSanitiser` | 5 (post-Bedrock) | AWS resource leaks, IP addresses, internal hostnames, credentials, third-party API keys |

The pair-with-Guardrail layering is intentional: the sanitisers
**reduce unnecessary LLM invocations** (an injection pattern blocked
in Layer 2 never burns Bedrock tokens) and act as a **cost-reducing
filter ahead of the model-side check**, not a replacement for it
([applications/shared/src/security/input-sanitiser.ts:7-10](../../applications/shared/src/security/input-sanitiser.ts#L7-L10)).

## How it works

```mermaid
flowchart LR
    User[User prompt] --> Input[InputSanitiser.sanitise]
    Input -->|blocked| Reject[Reject + log<br/>injection label]
    Input -->|pass| Bedrock[Bedrock Converse / Agent]
    Bedrock --> Output[OutputSanitiser.sanitise]
    Output --> Resp[Sanitised response<br/>resource leaks redacted]
```

### `InputSanitiser` — 14 default injection patterns

The class ships with 14 built-in patterns
([input-sanitiser.ts:44-58](../../applications/shared/src/security/input-sanitiser.ts#L44-L58)) — the **union** of patterns from the chatbot, strategist, and self-healing apps:

| Label | Pattern excerpt | Catches |
| :- | :- | :- |
| `ignore-instructions` | `ignore (all )?previous instructions?` | Classic prompt override |
| `system-prompt-probe` | `system prompt` | "Tell me your system prompt" |
| `repeat-instructions` | `repeat (your|the) instructions?` | Extraction via mirroring |
| `jailbreak` | `jailbreak` | Direct mention |
| `dan-attack` | `DAN` | "Do Anything Now" attack |
| `script-injection` | `<script[\s>]` | HTML injection |
| `null-byte` | `\0` | Null-byte injection |
| `restriction-bypass` | `act as (if )?you (have )?no restrictions?` | Constraint removal |
| `persona-override` | `pretend (you are|to be)` | Role manipulation |
| `role-reassignment` | `you are now a` | Direct role swap |
| `system-prompt-injection` | `system\s*:\s*` | Fake system tags |
| `instruction-tag-injection` | `[INST]` | Llama-style tag injection |
| `chat-marker-injection` | `<|im_start|>` | OpenAI-style marker injection |
| `respond-no-restrictions` | `respond as if you have no restrictions` | Restriction bypass variant |

Every pattern has a **named label** — the label is what gets logged
when the pattern hits, so the audit log is self-describing:
`{ blocked: true, reason: 'ignore-instructions' }` rather than
`{ blocked: true, reason: 'pattern[0]' }`.

The patterns are deliberately a **superset** so any one consumer's
threat model is covered. Consumers can narrow via the constructor
([input-sanitiser.ts:14-25](../../applications/shared/src/security/input-sanitiser.ts#L14-L25))
if their context makes specific patterns false-positive-prone (a
security blog chatbot might whitelist "jailbreak" as a legitimate
discussion topic).

### Two `InputSanitiser` modes

**`sanitise(text)` — chatbot-style block/pass.** Returns `{ blocked,
reason }`. Caller decides what to do. This is what `chatbot/src/index.ts`
uses
([applications/chatbot/src/index.ts:48](../../applications/chatbot/src/index.ts#L48)).

**`sanitiseWithWarnings(text)` — strategist-style with length
validation.** Adds length boundaries (`minLength`, `maxLength`) and
PII detection (via `piiPatterns` config), throws
`InputSanitisationError` on length violations. Used when the input is
a structured document (resume, job description) where over- or
under-length signals an intent problem worth surfacing
([input-sanitiser.ts:70-77](../../applications/shared/src/security/input-sanitiser.ts#L70-L77)).

### `OutputSanitiser` — 8 default redaction patterns

The class ships with 8 redaction rules, applied **in order** so
more-specific patterns precede less-specific ones
([output-sanitiser.ts:46-69](../../applications/shared/src/security/output-sanitiser.ts#L46-L69)):

| Order | Pattern excerpt | Replacement | Catches |
| -: | :- | :- | :- |
| 1 | `arn:aws:[a-zA-Z0-9-]+:[a-z0-9-]*:\d{12}:[^\s,)}\]]+` | `[AWS Resource]` | Full AWS ARNs |
| 2 | `\b\d{12}\b` | `[Account ID]` | Bare 12-digit account IDs |
| 3 | `\b[A-Z0-9]{20}\b` | `[Access Key]` | 20-char access keys |
| 4 | `https?://\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}…` | `[Internal URL]` | URL with IP |
| 5 | `\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b` | `[IP Address]` | Bare IP |
| 6 | `\b[a-z][a-z0-9-]{2,62}\.(internal|local|cluster\.local)\b` | `[Internal Host]` | K8s service DNS, VPC internal |
| 7 | `(?:api[_-]?key|secret|token|password)\s*[:=]\s*\S+` | `[REDACTED]` | `key=value` credentials |
| 8 | `dynamodb:.*?table/[^\s,)}\]]+` | `[DynamoDB Table]` | Table identifiers |
| 9 | `\bpc-[a-zA-Z0-9]{32,}\b` | `[Pinecone Key]` | Pinecone API key prefix |

### Order matters — ARN before Account ID

Rule ordering is **not commutative**. The ARN pattern (rule 1)
contains a 12-digit account-id substring; if rule 2 ran first it
would partially redact ARNs to `arn:aws:lambda:us-east-1:[Account
ID]:function:foo`, leaving a half-redacted artefact. By running the
ARN rule first the whole ARN collapses to `[AWS Resource]` and rule
2 only matches bare 12-digit numbers in subsequent text
([output-sanitiser.ts:43-45](../../applications/shared/src/security/output-sanitiser.ts#L43-L45)
— the source explicitly documents this).

This pattern — **specific-then-general** — is the canonical
ordering rule for any cascading-regex redactor. Generic-then-specific
would always produce partial redactions on overlapping matches.

### Extensibility — `extraRules` vs `rules`

The constructor accepts two configurations
([output-sanitiser.ts:80-86](../../applications/shared/src/security/output-sanitiser.ts#L80-L86)):

- **`extraRules`** — appended to the defaults. Use when adding
  domain-specific patterns on top of the shared base.
- **`rules`** — replaces the defaults entirely. Use when the
  defaults are unsuitable (e.g. a chatbot that *should* echo
  internal hostnames for a debug surface).

The split is deliberate: `extraRules` is the safe default; `rules`
is the escape hatch. Both are typed as `ReadonlyArray<OutputRedactionRule>`
so consumers cannot accidentally mutate the default set.

### Why two classes, not one

The two sanitisers operate on different surfaces (prompts vs
responses) with different semantics (block-or-pass vs
redact-and-pass-through) and different blast radius (a blocked
prompt costs nothing; a leaked output is a real breach). Combining
them into one class would force callers to choose modes per call
and to share a configuration model that fits neither well.

Kept separate, each class has a single concern: the
[Single-Responsibility Principle](https://en.wikipedia.org/wiki/Single-responsibility_principle)
applied at the security layer.

## Implementation in this codebase

| Concern | Location |
| :- | :- |
| Input sanitiser | [applications/shared/src/security/input-sanitiser.ts](../../applications/shared/src/security/input-sanitiser.ts) |
| Output sanitiser | [applications/shared/src/security/output-sanitiser.ts](../../applications/shared/src/security/output-sanitiser.ts) |
| Shared types | [applications/shared/src/security/types.ts](../../applications/shared/src/security/types.ts) |
| Primary consumer (chatbot Layer 2 + 5) | [applications/chatbot/src/index.ts:48-49](../../applications/chatbot/src/index.ts#L48-L49) |
| Module-scoped instances | held at module top of every consumer Lambda for instance reuse across warm invocations |
| Tests | sibling `*.test.ts` files for each class |

## Tradeoffs

**Defence-in-depth, not defence-in-isolation.** The sanitisers
exist to *complement* the Bedrock Guardrail, not replace it. A
Guardrail bypass on an attack pattern the sanitiser catches is still
blocked at Layer 2; a sanitiser pattern miss is caught by the
Guardrail at Layer 3. Each layer has a different false-positive /
false-negative profile, and stacking them gives a better aggregate.
The cost is that legitimate prompts containing words like
"jailbreak" are blocked at Layer 2 before the Guardrail gets a
chance to classify them in context. Acceptable: the chatbot is a
narrow portfolio Q&A surface, not a security forum.

**Pattern union vs per-app overrides.** The 14 + 8 defaults are the
**union** of every consumer's patterns
([input-sanitiser.ts:38-41](../../applications/shared/src/security/input-sanitiser.ts#L38-L41)).
Cheaper to maintain one shared list than per-app drift; the cost is
that any one app pays the per-pattern regex cost for patterns it
does not need. At the platform's scale the cost is negligible
(regex compile happens once per process; per-request evaluation is
microseconds against typical prompt lengths).

**Static patterns, not learned.** Both classes are regex-based, not
ML-based. The same tradeoff as the [PiiScrubber](pii-scrubber.md):
deterministic, fast, testable, but limited to the patterns
explicitly enumerated. New attack patterns require code changes,
not retraining. The platform is small enough that the per-PR
addition cost is low; at scale this would become a maintenance bug
and an LLM-or-classifier-based detector would be the right
investment.

**`OutputSanitiser` does not strip references in code blocks.**
The patterns apply uniformly; an ARN inside a ` ```ts ` block is
redacted just like an ARN in prose. This is conservative — a leaked
ARN inside a code fence is still a leak. The cost is that legitimate
documentation snippets quoting AWS examples get redacted; the
benefit is the absence of "the code block escape hatch" failure
mode where attackers cause leaks by wrapping content in
backticks.

## Deeper detail

- [docs/concepts/bedrock-rag-surface.md](bedrock-rag-surface.md) —
  the six-layer defence-in-depth model these sanitisers participate
  in.
- [docs/concepts/pii-scrubber.md](pii-scrubber.md) — the
  detector/policy primitive that handles PII redaction; lives
  alongside these classes but with a different responsibility.
- (planned) docs/runbooks/sanitiser-pattern-update.md — operator
  procedure to add a new injection pattern or redaction rule and
  roll it out across all consumers.
- (planned) docs/troubleshooting/false-positive-input-block.md —
  diagnosing a legitimately blocked prompt (e.g. a security
  researcher asking about prompt injection).

## Related concepts

- [self-healing-agent](self-healing-agent.md) — the agent has its
  own input sanitiser that runs ahead of the Bedrock call.
  Separate instance, different pattern set (focused on injection
  patterns in alarm names), same `InputSanitiser` base class.
- [tech-extractor-architecture](tech-extractor-architecture.md) —
  the deterministic extractor does *not* use these sanitisers
  (input is structured tarball content, output is structured
  evidence rows — no prompt surface).

<!--
Evidence trail (auto-generated):
- Source: applications/shared/src/security/input-sanitiser.ts (read on 2026-05-27, lines 1-100)
- Source: applications/shared/src/security/output-sanitiser.ts (read on 2026-05-27, lines 1-90)
- Source: applications/chatbot/src/index.ts (lines 14-50 on 2026-05-27)
- Cross-reference: docs/concepts/bedrock-rag-surface.md
-->
