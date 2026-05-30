# 🧱 Structured Output — Implementation Checklist

A checklist to verify your AI integration enforces strict JSON schema output every time — no parsers, no guesswork, no broken API calls.

---

## 1. 🎯 What You Are Enforcing

Structured output forces the model to return a **100% schema-compliant JSON object** on every single call. The model is not prompted to try — it is architecturally blocked from producing anything outside the schema.

- [ ] You have identified every endpoint or workflow where the AI output feeds into a downstream API call or database write
- [ ] Each of those flows has a defined JSON schema the model must conform to
- [ ] You are not relying on prompt instructions alone (e.g. "respond only in JSON") — you are using the model provider's native structured output feature

---

## 2. 🔒 Constrained Decoding — The Mechanism

Structured output works via **constrained decoding**: at each token generation step, the model is blocked from selecting any token that would violate the target schema. It is enforced at the sampling level, not the prompt level.

- [ ] You understand the difference between **prompted JSON** (unreliable) and **constrained decoding** (guaranteed)
- [ ] The model provider you are using supports native structured output (OpenAI `response_format`, Anthropic tool use with typed schemas, etc.)
- [ ] You are not post-processing raw text output with regex or a custom parser — the backend receives a clean object directly

**What this removes from your stack:**
```
❌ JSON.parse(response.text)          — brittle, breaks on any deviation
❌ regex extraction from prose         — fragile, maintenance burden
❌ retry loops on malformed output     — wasted latency and tokens
✅ response.parsed                     — typed, clean, direct
```

---

## 3. 📐 Schema Definition

- [ ] Every structured output call has a **formally defined schema** (JSON Schema, Pydantic model, Zod schema, or equivalent)
- [ ] Schema fields are typed — no untyped `any` or `object` fields where avoidable
- [ ] Required fields are explicitly marked — the model cannot omit them
- [ ] Schema does not include optional fields that the model might hallucinate values for unnecessarily
- [ ] Field names are unambiguous — the model uses the name as a semantic hint

**Example — Spotify play request schema:**

```json
{
  "type": "object",
  "properties": {
    "song_title": { "type": "string" },
    "artist":     { "type": "string" }
  },
  "required": ["song_title", "artist"],
  "additionalProperties": false
}
```

- [ ] `additionalProperties: false` is set — model cannot invent extra fields
- [ ] Schema is version-controlled alongside your application code

---

## 4. 🔗 API Compatibility

- [ ] The structured output schema maps **exactly** to the target API's expected input format
- [ ] Field names match the downstream API's parameter names precisely (no transformation layer needed)
- [ ] Data types match — strings are strings, numbers are numbers, no silent coercions required
- [ ] The schema has been validated against a real API call in a test environment
- [ ] If the downstream API updates its schema, your structured output schema is updated in sync

**Real-world check:**
```
Model output JSON  →  must pass directly into  →  downstream API call
       ↑                                                   ↑
  your schema                                      API docs schema
  must match exactly
```

---

## 5. 🧪 Implementation — Code Review Checklist

- [ ] `response_format` (or equivalent) is set on every AI call that feeds structured data downstream — not just some of them
- [ ] The parsed response object is used directly — no `.text` → manual parse anywhere in the flow
- [ ] Schema is defined once and reused — not duplicated across multiple call sites

**OpenAI example (Python):**

```python
from pydantic import BaseModel
from openai import OpenAI

client = OpenAI()

class SpotifyPlayRequest(BaseModel):
    song_title: str
    artist: str

response = client.beta.chat.completions.parse(
    model="gpt-4o",
    messages=[
        {"role": "user", "content": "Play Hey Jude by The Beatles"}
    ],
    response_format=SpotifyPlayRequest,
)

play_request = response.choices[0].message.parsed
# play_request.song_title → "Hey Jude"
# play_request.artist     → "The Beatles"
# Clean. Typed. No parser needed.
```

---

## 6. ⚠️ Edge Case Handling

- [ ] You have tested what happens when the user input is **ambiguous** (e.g. "play something chill") — does the model still produce a valid schema or surface a graceful error?
- [ ] You have tested **missing information** scenarios — what if the user says "play that song" without naming it?
- [ ] Refusal handling is in place — if the model cannot confidently populate required fields, it fails gracefully rather than hallucinating values
- [ ] Schema validation is run server-side as a safety net even when constrained decoding is active

---

## 7. 🛡️ Error Handling

- [ ] Parsing errors (if they occur) are caught explicitly — not silently swallowed
- [ ] A fallback or retry strategy exists for cases where structured output fails unexpectedly (provider outage, model downgrade, etc.)
- [ ] Errors are logged with the raw model output so failures can be diagnosed
- [ ] The downstream API call is **never attempted** if schema validation fails — fail fast, not silently

```python
if response.choices[0].message.refusal:
    # Model could not produce a valid structured response
    raise ValueError("Model refused to generate structured output")

play_request = response.choices[0].message.parsed
if not play_request:
    raise ValueError("Structured output parsing returned None")
```

---

## 8. 📋 Logging & Observability

- [ ] Structured output calls are logged with their schema name/version so you know which schema produced which output
- [ ] Schema validation failures are tracked as a metric — a spike signals prompt drift or user input pattern changes
- [ ] You log whether the model produced the output on the first attempt or required a retry
- [ ] PII fields in structured output (names, emails, etc.) are scrubbed before logging

---

## 9. 🧪 Testing

- [ ] Unit test: happy path — valid user input produces schema-compliant output
- [ ] Unit test: ambiguous input — model returns a graceful error, not a hallucinated schema
- [ ] Unit test: schema is passed `additionalProperties: false` and model cannot add unexpected fields
- [ ] Integration test: structured output object passes directly into the downstream API call without transformation
- [ ] Regression test: if the schema changes, existing test cases catch breaking changes before deployment

---

## ✅ Final Sign-Off

| Area | Owner | Verified | Date |
|---|---|---|---|
| Constrained decoding used (not prompted JSON) | | ☐ | |
| Schema defined with strict types and required fields | | ☐ | |
| `additionalProperties: false` enforced | | ☐ | |
| Schema matches downstream API exactly | | ☐ | |
| No manual JSON parsing anywhere in the flow | | ☐ | |
| Edge cases and ambiguous input tested | | ☐ | |
| Error handling and refusal handling in place | | ☐ | |
| Logging and observability active | | ☐ | |
| Full test suite passing | | ☐ | |

---

## Full Flow

```
User Input (natural language)
  → AI Model (constrained decoding active)
  → 100% schema-compliant JSON object ✅
  → Schema validation (safety net)
  → Downstream API call (no transformation needed)
  → Success
```

```
User Input (ambiguous / incomplete)
  → AI Model (cannot populate required fields)
  → Refusal or validation failure
  → Graceful error returned to user 🚫
  → API call never attempted
```

---

> **Rule:** If your backend contains a JSON parser, a regex extractor, or a retry loop to fix malformed AI output — you are not using structured output correctly. The backend should receive a typed object and use it directly.

---

## Audit Outcome — 2026-05-17

Applied across `applications/`. All Bedrock calls are Anthropic models;
the Converse/InvokeModel equivalent of constrained decoding is **forced
`tool_use`** (`tool_choice: { tool }`), so that is the bar used below.

**Constraint discovered:** on Claude, forced `tool_use` is incompatible
with extended thinking. Agents that need long-form reasoning therefore
keep thinking and use a strict Zod safety-net + fail-fast instead of
constrained decoding (§5/§7 satisfied; §2 deliberately waived with
rationale).

| Flow | Action |
|---|---|
| ingestion `ProfileExtractor` | already tool_use; added `.strict()` + `additionalProperties:false` |
| shared `BedrockChunkEnricher` | added `additionalProperties:false` + tests |
| resume-import extract-career / gap-analysis / enrich-role | added Zod safety-net, `additionalProperties:false`, typed fail-fast (enrich-role skips gracefully — optional) |
| shared `runAgent` | added forced-tool_use path (Converse `toolConfig`) + fail-fast on missing `toolUse` |
| job-strategist coach / research, article-pipeline qa / research | converted to forced tool_use + Zod; thinking disabled (incompatible) |
| job-strategist strategist-agent, article-pipeline writer-agent | **keep extended thinking**; added strict Zod safety-net + fail-fast on the structured payloads (tailored-resume JSON, writer metadata) |
| chatbot / chatbot-public / chatbot-authenticated | **Out of scope.** Conversational prose to a human / chat history — not a structured payload feeding an API or DB write (§1). `stripCodeFence` is presentation cleanup, not output parsing. No structured-output contract to enforce. |
| platform-job-watcher, platform-rds-bootstrap | No LLM calls. |

Prose sections inside otherwise-structured agents (cover letters,
reframes, MDX article body) remain free-form strings by design — the
checklist governs structured payloads, not generated prose.