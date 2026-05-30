---
title: Grounding verifier blocks a legitimately-grounded answer
type: troubleshooting
tags: [grounding, bedrock, haiku, rag, parser, false-positive]
sources:
  - applications/shared/src/grounding/bedrock-grounding-verifier.ts
  - applications/shared/src/grounding/grounding-types.ts
  - applications/chatbot/src/index.ts
created: 2026-05-27
updated: 2026-05-27
---

## Symptom

The chatbot returns the configured fallback message ("I cannot
answer that based on the documentation I have...") for a query where
the retrieved KB chunks **do** contain the answer. Cross-checking
the chunks manually shows every claim in the (suppressed) generated
answer is supported.

Or: in `warn` mode, the response includes the answer but with a
"grounding-not-confirmed" annotation when the answer is plainly
grounded.

Or: a `NOT_GROUNDED` verdict appears in the audit log for a request
whose answer the operator can verify against the same chunks.

## Root cause

The
[BedrockGroundingVerifier](../../applications/shared/src/grounding/bedrock-grounding-verifier.ts)
is **fail-safe by design** — any parse ambiguity in the Haiku 4.5
verifier's response resolves to `NOT_GROUNDED`
([bedrock-grounding-verifier.ts:4-7](../../applications/shared/src/grounding/bedrock-grounding-verifier.ts#L4-L7)).
False positives (genuinely grounded answers being blocked) are a
direct consequence of that design choice. Three mechanisms produce
them:

1. **Parser sensitivity to verdict token placement.** The parser
   tests `/\bGROUNDED\b/.test(text) && !/\bNOT_GROUNDED\b/.test(text)`
   ([bedrock-grounding-verifier.ts:60](../../applications/shared/src/grounding/bedrock-grounding-verifier.ts#L60)) —
   a Haiku output containing both tokens (e.g. *"The answer is
   GROUNDED. It is not NOT_GROUNDED."*) classifies as
   `NOT_GROUNDED` because the negative form appears anywhere in
   the text.
2. **Unparseable verifier output.** Haiku occasionally responds
   without either `GROUNDED` or `NOT_GROUNDED` (e.g. *"The answer
   appears supported"*). The parser logs a warning and falls
   through to `NOT_GROUNDED`
   ([bedrock-grounding-verifier.ts:65-72](../../applications/shared/src/grounding/bedrock-grounding-verifier.ts#L65-L72)).
3. **Chunk-window edge cases.** A claim in the answer is supported
   by *content spanning two chunks* — the first chunk introduces a
   concept, the second elaborates. Haiku can correctly note that
   "no single chunk supports the claim" and return `NOT_GROUNDED`.
   The answer is right; the verifier is doing its job conservatively.

## How to diagnose

### 1. Find the verifier invocation in CloudWatch Logs

The verifier emits an EMF metric and logs the *full* model output
when parsing falls through to `NOT_GROUNDED`. Filter on the log
group of the calling Lambda (`chatbot`, `chatbot-public`, or
`chatbot-authenticated`):

```
fields @timestamp, message
| filter @message like /grounding-verifier/
| sort @timestamp desc
| limit 50
```

A successful verifier call doesn't usually log; an
unparseable-output run logs
`[grounding-verifier] unparseable model output — defaulting to
NOT_GROUNDED: <first 200 chars>`
([bedrock-grounding-verifier.ts:65-69](../../applications/shared/src/grounding/bedrock-grounding-verifier.ts#L65-L69)).

### 2. Reproduce the verifier call directly

If you have the original prompt and the retrieved chunks (logged
upstream by the chatbot Lambda), replay the verifier call
manually:

```bash
aws bedrock-runtime converse \
  --model-id eu.anthropic.claude-haiku-4-5-20251001-v1:0 \
  --messages '[{"role":"user","content":[{"text":"<verifier prompt>"}]}]' \
  --inference-config maxTokens=400 \
  --query 'output.message.content[0].text'
```

The verifier prompt is
([bedrock-grounding-verifier.ts:44-58](../../applications/shared/src/grounding/bedrock-grounding-verifier.ts#L44-L58)):

```
Given the following source chunks:
[1] <chunk 1>
[2] <chunk 2>
…
And the following generated answer:
<answer>

Is every claim in the answer directly supported by the source chunks?
Reply on the first line with exactly GROUNDED or NOT_GROUNDED.
Then "Reason: <brief reason>".
If NOT_GROUNDED, add "Claims: <semicolon-separated unsupported claims>".
```

Inspect Haiku's exact output. Note the **first line** in particular
— the verdict regex looks at the whole text but the prompt requests
the verdict on the first line.

### 3. Identify the mechanism

| Observation in Haiku output | Mechanism |
| :- | :- |
| Both `GROUNDED` and `NOT_GROUNDED` tokens appear | (1) Verdict-token-placement sensitivity |
| Neither token appears (Haiku used "supported" / "yes" / "consistent") | (2) Unparseable output |
| `NOT_GROUNDED` with a `Claims:` line citing a claim that **is** supported by reading chunks 1 + 2 together | (3) Chunk-window edge case |
| `NOT_GROUNDED` with a `Claims:` line citing a claim that you cannot find in any chunk | True positive — the model hallucinated; the verifier is correct |

### 4. Cross-check the calling mode

The chatbot uses `mode: 'block'`
([applications/chatbot/src/index.ts:50](../../applications/chatbot/src/index.ts#L50))
which replaces the answer with the fallback message. If the calling
Lambda has switched to `warn` mode the answer should still appear
in the response payload with an annotation; if the user sees
"fallback only" the mode is `block`.

## How to fix

### Mechanism 1 — verdict token placement

The pragmatic fix is **prompt engineering in the verifier** — make
Haiku less likely to mention both tokens. Update the system text
([bedrock-grounding-verifier.ts:44-58](../../applications/shared/src/grounding/bedrock-grounding-verifier.ts#L44-L58))
to:

```
Reply on the first line with EXACTLY one of:
  GROUNDED
  NOT_GROUNDED
Do not include both tokens anywhere in your response.
```

The parser regex change is a riskier alternative — making the
verdict check first-line-only would catch the false positive but
would also break on responses that put the verdict at the end (e.g.
after a chain-of-thought). Prompt-side is the safer place to fix.

### Mechanism 2 — unparseable output

Either:

**Switch to tool-use enforcement.** Move from free-text Converse to
tool-use Converse with `toolChoice: { tool: { name: 'grounding_verdict' }}`
and a strict input schema (`enum: ['GROUNDED', 'NOT_GROUNDED']`).
This mirrors the
[ProseSafeTagger](../concepts/prose-safe-alias-gating.md) pattern
and eliminates the parser-fall-through path entirely. The cost is
a higher Bedrock surface (tool-use bytes), but the upside is that
"unparseable" becomes structurally impossible. This is the
recommended long-term fix.

**Or relax the parser.** Accept `(supports?|consistent|matches|yes)`
as `GROUNDED` synonyms. Risk: looser parsing means more
false-positive **groundings** (the failure mode the fail-safe was
designed to prevent). Only relax if the false-negative rate
materially harms the user experience and the false-positive cost is
known-bounded.

### Mechanism 3 — chunk-window edge case

This one is more interesting: Haiku is **correct** that no single
chunk supports the claim. The fix is on the **retrieval** side, not
the verifier side:

- **Increase chunking overlap.** The KB uses
  `HIERARCHICAL_TITAN` chunking with 60-token overlap by default
  ([infra/lib/stacks/bedrock/kb-stack.ts:182-194](../../infra/lib/stacks/bedrock/kb-stack.ts#L182-L194)).
  A claim that requires content spanning two chunks is exactly
  what overlap is supposed to mitigate. If this edge case is
  frequent, the overlap may be too small for the corpus's
  sentence-length distribution.
- **Increase TOP_K.** [multi-query-retrieval](../concepts/multi-query-retrieval.md)
  defaults to `TOP_K=8`. Lifting to `TOP_K=12` brings adjacent
  chunks into the verifier's view at the cost of more context
  tokens.
- **Adjust the verifier prompt.** Tell Haiku that *claims supported
  by combining adjacent chunks count as grounded*. The prompt today
  asks for *per-chunk* support implicitly; relaxing this to "across
  the chunks collectively" addresses the edge case but introduces
  a different false-positive risk (Haiku stitching unrelated chunks
  to back a hallucinated claim).

### True positive — verifier is correct

The model **did** hallucinate. The fix is in the generation side:

- Investigate why the retrieval missed a relevant chunk
  (likely an embedding-similarity gap — see
  [multi-query-retrieval](../concepts/multi-query-retrieval.md)).
- Reduce the model's freedom to elaborate — lower `temperature` on
  the generation `ConverseCommand`
  ([applications/chatbot-public/src/invoke-claude.ts:30](../../applications/chatbot-public/src/invoke-claude.ts#L30)
  currently uses `temperature: 0.3`).
- Strengthen the system prompt's instruction to stay within
  retrieved content.

## How to prevent

- **Keep the fail-safe default.** Even if mechanisms 1 and 2 are
  noisy, blocking a grounded answer is a survivable failure mode;
  leaking a hallucination is not. The asymmetry is the right one
  for a portfolio chatbot whose recruiter audience expects
  *accurate* answers, not *complete* ones.
- **Use tool-use enforcement.** Mechanism 2 is fully preventable
  by switching the verifier to tool-use mode (see fix above). This
  is the same lesson the
  [ProseSafeTagger](../concepts/prose-safe-alias-gating.md) already
  applies for its own categorisation task.
- **Monitor the false-positive rate.** Emit a CloudWatch metric
  `GroundingFalsePositive` whenever a `NOT_GROUNDED` verdict is
  *manually* overridden during operator review. If the count
  rises, mechanism 3 may be growing — investigate retrieval, not
  verifier.
- **Document the chunking strategy alongside the verifier.** The
  60-token overlap is a load-bearing assumption for the verifier's
  per-chunk semantics. Changing one without the other will produce
  this incident class.

<!--
Evidence trail (auto-generated):
- Source: applications/shared/src/grounding/bedrock-grounding-verifier.ts (read in full on 2026-05-27)
- Source: applications/shared/src/grounding/grounding-types.ts (read on 2026-05-27)
- Source: applications/chatbot/src/index.ts (lines 48-50 on 2026-05-27)
- Source: applications/chatbot-public/src/invoke-claude.ts (line 30 on 2026-05-27)
- Source: infra/lib/stacks/bedrock/kb-stack.ts (lines 182-194 on 2026-05-27)
- Cross-reference: docs/concepts/bedrock-rag-surface.md, docs/concepts/prose-safe-alias-gating.md
-->
