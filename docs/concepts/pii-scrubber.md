---
title: PII scrubber
type: concept
tags: [privacy, security, pii, bedrock, semantic-cache, comprehend]
sources:
  - applications/shared/src/security/pii-scrubber.ts
  - applications/shared/src/security/regex-pii-detector.ts
  - applications/shared/src/security/comprehend-pii-detector.ts
  - applications/shared/src/security/pii-types.ts
created: 2026-05-27
updated: 2026-05-27
---

## Overview

The `PiiScrubber` is a standalone redactor designed to run before any
sink that can leak personally identifiable information: the LLM call,
the database write, the log line, and — most importantly — the
embedding that feeds the [semantic cache](caching-tiers.md). It is
deliberately separate from `InputSanitiser`, which only warns and
only sees the *input* flow; the scrubber acts on every PII-bearing
*output* path
([applications/shared/src/security/pii-scrubber.ts:1-7](../../applications/shared/src/security/pii-scrubber.ts#L1-L7)).

The scrubber follows the **detector/policy** split: an `IPiiDetector`
finds spans, a `RedactionPolicy` maps each PII type to a mask token,
and the scrubber applies the masks right-to-left so earlier offsets
stay valid
([pii-scrubber.ts:39-58](../../applications/shared/src/security/pii-scrubber.ts#L39-L58)).
This shape lets the detector swap (regex today, Comprehend later)
without touching the calling code.

## How it works

```mermaid
flowchart LR
    Text[Raw text<br/>resume, query, log line] --> Scrubber[PiiScrubber.scrub]
    Scrubber --> Detect[detector.detect<br/>IPiiDetector]
    Detect --> Spans[PiiSpan[]<br/>sorted by start]
    Spans --> Replace[Replace right-to-left<br/>policy[type] mask]
    Replace --> Redacted[Redacted text<br/>+ spans + found flag]
    subgraph Detectors
        Regex[RegexPiiDetector<br/>default]
        Comprehend[ComprehendPiiDetector<br/>stub — throws]
    end
    Detect -.-> Regex
    Detect -.-> Comprehend
```

### PII types covered

Six types are defined
([applications/shared/src/security/pii-types.ts:20-26](../../applications/shared/src/security/pii-types.ts#L20-L26)):

| Type | Default mask | Detector strategy |
| :- | :- | :- |
| `EMAIL` | `[EMAIL]` | RFC-5322-ish regex |
| `PHONE` | `[PHONE]` | `NNN[sep]NNN[sep]NNNN` regex |
| `SSN` | `[SSN]` | `NNN-NN-NNNN` regex |
| `CREDIT_CARD` | `[CC]` | 13–16 digits with optional separators |
| `IP` | `[IP]` | dotted-quad regex |
| `NAME` | `[NAME]` | low-recall heuristic (see below) |

The redaction policy is configurable but defaults to
`DEFAULT_REDACTION_POLICY`
([pii-types.ts:39-46](../../applications/shared/src/security/pii-types.ts#L39-L46))
which uses the labels above. A caller can supply a custom map (e.g.
`EMAIL → '<redacted-email>'`) by passing `policy` in the
`PiiScrubberConfig`. If a detector emits a type the policy does not
cover, the scrubber falls back to `[${type}]` rather than crashing
([pii-scrubber.ts:50-53](../../applications/shared/src/security/pii-scrubber.ts#L50-L53)).

### Detector contract

Two implementations of `IPiiDetector`
([pii-types.ts:50](../../applications/shared/src/security/pii-types.ts#L50))
exist today:

**`RegexPiiDetector` (default).** Six rule templates compiled to
`RegExp` instances at construction
([regex-pii-detector.ts:18-26](../../applications/shared/src/security/regex-pii-detector.ts#L18-L26)).
Each rule's `lastIndex` is reset before each detect call, and a
zero-length match safeguard prevents infinite loops
([regex-pii-detector.ts:44-50](../../applications/shared/src/security/regex-pii-detector.ts#L44-L50)).
Spans are returned sorted by start offset.

The `NAME` rule is deliberately conservative:
`(?<=\b(?:name|candidate|applicant|by)\b[:\s]+)[A-Z][a-z]+ [A-Z][a-z]+`
([regex-pii-detector.ts:27](../../applications/shared/src/security/regex-pii-detector.ts#L27))
— only capitalised bigrams **adjacent to a name-context keyword**.
The header comment explains why: *"The NAME heuristic is deliberately
low-recall (only capitalised bigrams adjacent to a name-context
keyword) to avoid over-redacting ordinary capitalised phrases.
ML-grade name detection is the `ComprehendPiiDetector`'s job"*
([regex-pii-detector.ts:3-7](../../applications/shared/src/security/regex-pii-detector.ts#L3-L7)).

**`ComprehendPiiDetector` (stub).** Currently throws on call
([comprehend-pii-detector.ts:11-16](../../applications/shared/src/security/comprehend-pii-detector.ts#L11-L16)):

```ts
throw new Error(
    'ComprehendPiiDetector not implemented — see the shared PII scrubber ' +
    'GitHub issue. Use RegexPiiDetector until Comprehend is wired in.',
);
```

The class exists to lock in the swap point — when Amazon
Comprehend's `DetectPiiEntities` API is wired in, the class body
changes but no caller does. Until then, do not instantiate it;
default to `RegexPiiDetector`.

### Right-to-left replacement

The scrubber applies masks in reverse-span-order
([pii-scrubber.ts:44-58](../../applications/shared/src/security/pii-scrubber.ts#L44-L58)):

```ts
// Apply right-to-left so earlier offsets stay valid.
for (let i = spans.length - 1; i >= 0; i--) {
    const sp = spans[i];
    const token = this.policy[sp.type] ?? `[${sp.type}]`;
    redacted = redacted.slice(0, sp.start) + token + redacted.slice(sp.end);
}
```

This avoids the off-by-N bug a naïve left-to-right pass would
introduce: each replacement changes the string length, so left-to-right
indices drift. Right-to-left, the unprocessed offsets (lower-indexed)
remain valid because the slicing happens *after* their range.

### Return shape

`scrub()` returns a `PiiScrubResult`:

```ts
interface PiiScrubResult {
    redacted: string;     // the masked output
    spans: PiiSpan[];     // for logging/tests; never re-emitted to sinks
    found: boolean;       // shortcut for "did anything match?"
}
```

The `spans[].value` field carries the *original* matched substring
([pii-types.ts:34](../../applications/shared/src/security/pii-types.ts#L34))
— useful for unit tests and metric labels. Callers must not write
that back to a sink; it defeats the scrub.

## Implementation in this codebase

| Concern | Location |
| :- | :- |
| Scrubber + policy plumbing | [applications/shared/src/security/pii-scrubber.ts](../../applications/shared/src/security/pii-scrubber.ts) |
| Default regex detector | [applications/shared/src/security/regex-pii-detector.ts](../../applications/shared/src/security/regex-pii-detector.ts) |
| Comprehend detector (stub) | [applications/shared/src/security/comprehend-pii-detector.ts](../../applications/shared/src/security/comprehend-pii-detector.ts) |
| Types + default policy | [applications/shared/src/security/pii-types.ts](../../applications/shared/src/security/pii-types.ts) |
| Tests | [applications/shared/src/security/pii-scrubber.test.ts](../../applications/shared/src/security/pii-scrubber.test.ts), [regex-pii-detector.test.ts](../../applications/shared/src/security/regex-pii-detector.test.ts) |
| Primary caller (semantic cache) | [applications/shared/src/cache/pg-semantic-cache.ts:43](../../applications/shared/src/cache/pg-semantic-cache.ts#L43) |
| Other callers (chatbot, job-strategist) | grep `PiiScrubber` across `applications/` |

## Tradeoffs

**Regex first, Comprehend later.** The detector interface was
designed for the swap from day one — the contract is symmetrical so
that wiring Comprehend in becomes a class-body change inside
`ComprehendPiiDetector` plus a constructor flag at the call site.
The accepted residual: regex misses non-keyword-anchored names
("Dear John Smith,") and unusual phone formats. The choice was
deliberate — those misses are recoverable when Comprehend lands; an
over-eager regex that masks all capitalised bigrams would silently
shred genuine content and there is no recovery from a write to the
embedding store.

**Six PII types, not more.** The set is intentionally minimal —
addresses, dates of birth, passport numbers, etc. could be detected
but were deferred. Adding a type requires (a) a `PiiType` union
extension, (b) a `RedactionPolicy` default, (c) a detector rule.
Adding it on the type side first means any unrecognised mask from a
future detector falls through to the `[${type}]` fallback rather
than crashing
([pii-scrubber.ts:50-53](../../applications/shared/src/security/pii-scrubber.ts#L50-L53)).

**`spans[].value` is dangerous.** It is the original PII substring,
returned so tests can assert. Callers that log the result must log
`{ redacted, found }` only — never `spans`. The field is annotated
*"for logging/tests; never re-emitted to sinks"* in the type
([pii-types.ts:33-34](../../applications/shared/src/security/pii-types.ts#L33-L34)).
This is a deliberate trust contract: the scrubber returns the
sensitive data alongside the safe data; the caller must keep them
separate.

**Detection runs once per text, then mask.** No caching across calls
— the detector recompiles regex `lastIndex` per call but compiles
each `RegExp` once per `RegexPiiDetector` instance. For high-volume
paths (e.g. the semantic cache, which scrubs every query) the
instance is held as a private field on the cache class
([pg-semantic-cache.ts:43](../../applications/shared/src/cache/pg-semantic-cache.ts#L43))
so the compilation cost is amortised over the process lifetime.

## Deeper detail

- [docs/concepts/caching-tiers.md](caching-tiers.md) — the semantic
  cache: the highest-volume caller, runs `scrub` ahead of every
  embedding.
- (planned) docs/concepts/input-sanitiser.md — the sibling
  primitive: it sees the *input* flow and only warns, where this
  scrubber acts on the *output* flow and redacts.
- (planned) docs/runbooks/pii-rule-update.md — operator procedure
  to add a new PII type (the three-touchpoint change above).
- (planned) docs/decisions/0003-regex-detector-first.md — the
  detector-pattern ADR formalising the deliberate "regex first,
  Comprehend later" path.

## Related concepts

- [self-healing-agent](self-healing-agent.md) — also has its own
  input sanitiser, distinct from this scrubber (the agent's runs
  ahead of the Bedrock call to catch prompt injection, not PII).
- Bedrock grounding verifier (sibling primitive at
  [applications/shared/src/grounding/](../../applications/shared/src/grounding/))
  — defensive output check, paired with this defensive input/output
  scrub for an end-to-end "nothing sensitive leaves, nothing
  hallucinated returns" surface.

<!--
Evidence trail (auto-generated):
- Source: applications/shared/src/security/pii-scrubber.ts (read in full on 2026-05-27)
- Source: applications/shared/src/security/regex-pii-detector.ts (read on 2026-05-27)
- Source: applications/shared/src/security/comprehend-pii-detector.ts (read on 2026-05-27)
- Source: applications/shared/src/security/pii-types.ts (read on 2026-05-27)
- Source: applications/shared/src/cache/pg-semantic-cache.ts (line 43 on 2026-05-27)
-->
