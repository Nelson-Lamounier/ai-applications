# RAG Sub-project 2 — App Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the shared `PiiScrubber` and `BedrockGroundingVerifier` into all 5 apps — redact PII before every LLM/DB/log sink; verify grounding post-generation (chatbot+job-strategist `block`, resume-import+article-pipeline `flag`); ingestion PII-only.

**Architecture:** One module-scoped `PiiScrubber` singleton per file (stateless). Grounding runs at the orchestration layer (Lambda handler / `run-pipeline` / gap-analysis), never inside sync `parseResponse`. Always-on, no flags. Verifier infra errors fail-open (never hard-fail the host request). Source spec: `RAG_Subproject2_App_Wiring_Design_Review.md`.

**Tech Stack:** TypeScript (NodeNext), jest + ts-jest, `@bedrock/shared` (PiiScrubber, BedrockGroundingVerifier). Mock Bedrock/DB/Tavily in tests — no live calls.

---

## Branch

All work on a branch off `feat/rag-shared-safety` (sub-project 1 modules must be present; PR #4 not yet merged):

```
git checkout feat/rag-shared-safety
git checkout -b feat/rag-sp2-app-wiring
```

Per-app test command: `cd applications/<app> && npx jest <path> -v`. Per-app typecheck: `cd applications/<app> && npx tsc --noEmit`. Commits follow the **git-commit skill** (tests + typecheck green for the touched app, atomic, no AI authorship trailer).

---

## File Structure / Task Map

| Task | App | Concern | Primary files |
|---|---|---|---|
| 1 | chatbot | PII | `src/index.ts` |
| 2 | chatbot | grounding (block) | `src/agents/chatbot-agent.ts`, `src/index.ts` |
| 3 | job-strategist | PII (redact) | `src/agents/research-agent.ts` |
| 4 | job-strategist | grounding (block) | `src/run-pipeline.ts` |
| 5 | ingestion | PII | `src/agents/ProfileInputCollector.ts`, `src/repositories/RepositoryProfileEmbeddingsRepository.ts` |
| 6 | resume-import | PII | `src/bedrock/extract-career.ts`, `enrich-role.ts`, `src/tools/tavily-cache.ts`, `src/embed.ts`, `run-import.ts` |
| 7 | resume-import | grounding (flag) | `src/bedrock/gap-analysis.ts`, `run-import.ts` |
| 8 | article-pipeline | PII | `src/agents/research-agent.ts`, `run-pipeline.ts` |
| 9 | article-pipeline | grounding (flag) | `run-pipeline.ts` |
| 10 | all | final verification | — |

Each task: locate the quoted current code, apply the transformation, add the TDD test, run app tests + typecheck, commit.

---

## Task 1: chatbot — PII scrub user prompt + error logs

**Files:** Modify `applications/chatbot/src/index.ts`; Test `applications/chatbot/src/handler.test.ts` (append).

- [ ] **Step 1: Write the failing test**

Append inside the existing top-level `describe` in `applications/chatbot/src/handler.test.ts` (it already mocks the agent invoke; reuse that mock — locate how the existing tests assert on the agent call and follow that pattern):

```typescript
it('redacts PII from the prompt before the agent is invoked', async () => {
    const event = makeEvent({ prompt: 'my email is jane.doe@example.com and ssn 123-45-6789' });
    await handler(event as never, {} as never);
    const passedPrompt = invokeChatbotAgentMock.mock.calls.at(-1)?.[1] as string;
    expect(passedPrompt).not.toContain('jane.doe@example.com');
    expect(passedPrompt).not.toContain('123-45-6789');
    expect(passedPrompt).toContain('[EMAIL]');
    expect(passedPrompt).toContain('[SSN]');
});
```

Note: `makeEvent`, `handler`, and `invokeChatbotAgentMock` — use the existing test file's helpers/mocks. If the existing test mocks `invokeChatbotAgent` under a different variable, match that name. If no helper exists, build the event inline exactly like the nearest existing test in the file.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd applications/chatbot && npx jest src/handler.test.ts -t "redacts PII from the prompt" -v`
Expected: FAIL (prompt still contains the email/SSN).

- [ ] **Step 3: Implement**

In `applications/chatbot/src/index.ts`:

1. Add `PiiScrubber` to the existing `@bedrock/shared` import (the line currently importing `InputSanitiser, OutputSanitiser, ...`):

```typescript
import { log, emitEmfMetric, InputSanitiser, OutputSanitiser, PiiScrubber, withSpan } from '@bedrock/shared';
```

2. Add a module-scoped singleton next to the existing `inputSanitiser`/`outputSanitiser` instances:

```typescript
const piiScrubber = new PiiScrubber();
```

3. After the existing injection check (`const inputCheck = inputSanitiser.sanitise(body.prompt);` … blocked guard), redact before the agent call. Replace the value passed to `invokeChatbotAgent` so the redacted text is sent:

```typescript
const inputCheck = inputSanitiser.sanitise(body.prompt);
if (inputCheck.blocked) { /* existing return unchanged */ }
const scrubbedPrompt = piiScrubber.scrub(inputCheck.sanitised).redacted;
// pass scrubbedPrompt where inputCheck.sanitised was previously passed:
const result = await invokeChatbotAgent(
    { agentId: config.agentId, agentAliasId: config.agentAliasId },
    scrubbedPrompt,
    sessionId,
    callerContext,
);
```

4. Scrub the agent-error log message. At the agent-error `log('ERROR', 'Agent invocation failed', { error: errorMessage, ... })` site, redact first:

```typescript
log('ERROR', 'Agent invocation failed', {
    error: piiScrubber.scrub(errorMessage).redacted,
    errorName,
    durationMs,
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd applications/chatbot && npx jest src/handler.test.ts -t "redacts PII from the prompt" -v`
Expected: PASS. Then full file: `npx jest src/handler.test.ts` — all green.

- [ ] **Step 5: Typecheck + commit**

Run: `cd applications/chatbot && npx tsc --noEmit` (clean).

```
git add applications/chatbot/src/index.ts applications/chatbot/src/handler.test.ts
git commit -m "feat(chatbot): redact PII before Bedrock Agent invoke and error logs"
```

---

## Task 2: chatbot — grounding (block) via Agent trace citations

**Files:** Modify `applications/chatbot/src/agents/chatbot-agent.ts`, `applications/chatbot/src/index.ts`; Test `applications/chatbot/src/handler.test.ts` (append).

- [ ] **Step 1: Write the failing test**

Append to `handler.test.ts`. The verifier must be mocked. Add a jest mock for `@bedrock/shared`'s `BedrockGroundingVerifier` at the top with the other mocks (follow the file's existing mock style); the mock's `verify` returns a controllable result:

```typescript
it('substitutes the grounding fallback when the answer is NOT_GROUNDED (block mode)', async () => {
    groundingVerifyMock.mockResolvedValueOnce({
        status: 'NOT_GROUNDED', reason: 'unsupported', ungroundedClaims: ['x'],
        answer: 'I do not have grounded info.',
    });
    const event = makeEvent({ prompt: 'tell me about the portfolio' });
    const res = await handler(event as never, {} as never);
    expect(JSON.parse(res.body).response).toBe('I do not have grounded info.');
});

it('returns the original answer when the verifier throws (fail-open)', async () => {
    groundingVerifyMock.mockRejectedValueOnce(new Error('bedrock down'));
    const event = makeEvent({ prompt: 'tell me about the portfolio' });
    const res = await handler(event as never, {} as never);
    expect(res.statusCode).toBe(200);
    expect(typeof JSON.parse(res.body).response).toBe('string');
});
```

`groundingVerifyMock` is the mocked `BedrockGroundingVerifier.prototype.verify`. Wire the mock so `new BedrockGroundingVerifier(...)` yields an object whose `verify` is `groundingVerifyMock` (mirror how the existing agent mock is constructed in this file).

- [ ] **Step 2: Run to verify it fails**

Run: `cd applications/chatbot && npx jest src/handler.test.ts -t "grounding fallback" -v`
Expected: FAIL (no grounding wired; response is the agent output, not the fallback).

- [ ] **Step 3: Implement — collect citations in the agent wrapper**

In `applications/chatbot/src/agents/chatbot-agent.ts`:

1. On the `InvokeAgentCommand` construction, add `enableTrace: true`:

```typescript
const command = new InvokeAgentCommand({
    agentId: config.agentId,
    agentAliasId: config.agentAliasId,
    sessionId,
    inputText: prompt,
    enableTrace: true,
    sessionState: callerContext
        ? { promptSessionAttributes: { callerRole: callerContext.callerRole } }
        : undefined,
});
```

2. While iterating `response.completion`, collect citation text alongside the answer chunks. Replace the existing stream loop with:

```typescript
const chunks: string[] = [];
const contextChunks: string[] = [];
for await (const event of response.completion) {
    if ('chunk' in event && event.chunk?.bytes) {
        chunks.push(new TextDecoder('utf-8').decode(event.chunk.bytes));
        for (const c of event.chunk?.attribution?.citations ?? []) {
            for (const ref of c.retrievedReferences ?? []) {
                const t = ref.content?.text;
                if (typeof t === 'string' && t.length > 0) contextChunks.push(t);
            }
        }
    }
}
```

3. Change the function's return so the caller also gets `contextChunks`. Find the current return shape (it returns `{ response: ... }` or similar) and add `contextChunks`:

```typescript
return { response: chunks.join(''), contextChunks };
```

Update the function's return type accordingly (add `contextChunks: string[]`). If callers destructure `.response`, they remain compatible.

- [ ] **Step 4: Implement — verify at the handler**

In `applications/chatbot/src/index.ts`:

1. Add `BedrockGroundingVerifier` to the `@bedrock/shared` import line (the one edited in Task 1). Add a module-scoped singleton:

```typescript
const groundingVerifier = new BedrockGroundingVerifier({ mode: 'block' });
```

2. Where the agent result is consumed (`const normalised = stripCodeFence(result.response);` before `outputSanitiser`), insert a fail-open grounding check and feed its answer onward:

```typescript
const normalised = stripCodeFence(result.response);
let answerForOutput = normalised;
const ctxChunks = result.contextChunks ?? [];
if (ctxChunks.length > 0) {
    try {
        const g = await groundingVerifier.verify({
            query: body.prompt,
            contextChunks: ctxChunks,
            answer: normalised,
        });
        answerForOutput = g.answer;
    } catch (e) {
        emitEmfMetric('BedrockChatbot', { Stage: 'grounding' },
            [{ name: 'GroundingError', value: 1, unit: 'Count' }]);
        log('WARN', 'Grounding verifier failed — returning original answer', {
            error: (e as Error).message,
        });
    }
} else {
    emitEmfMetric('BedrockChatbot', { Stage: 'grounding' },
        [{ name: 'GroundingSkippedNoContext', value: 1, unit: 'Count' }]);
}
const { sanitised: sanitisedResponse, wasRedacted } =
    outputSanitiser.sanitiseWithReport(answerForOutput);
```

(Use the actual EMF namespace already used elsewhere in `index.ts` if it differs from `BedrockChatbot`; match the existing `emitEmfMetric` calls in the file.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd applications/chatbot && npx jest src/handler.test.ts -v`
Expected: PASS (all, incl. both new tests).

- [ ] **Step 6: Typecheck + commit**

Run: `cd applications/chatbot && npx tsc --noEmit` (clean).

```
git add applications/chatbot/src/agents/chatbot-agent.ts applications/chatbot/src/index.ts applications/chatbot/src/handler.test.ts
git commit -m "feat(chatbot): grounding verify (block) from Agent trace citations, fail-open"
```

---

## Task 3: job-strategist — PII redaction before Bedrock/queries/logs

**Files:** Modify `applications/job-strategist/src/agents/research-agent.ts`; Test `applications/job-strategist/src/agents/research-agent.test.ts` (append).

- [ ] **Step 1: Write the failing test**

Append to `research-agent.test.ts` (follow the file's existing mocking of the vector store / Bedrock). Assert the JD text passed into the retrieval query and the Bedrock message is redacted:

```typescript
it('redacts PII from the job description before retrieval and Bedrock', async () => {
    // Arrange a JD containing PII; run the research agent with mocked store/LLM
    const jd = 'Contact hiring manager at recruiter@acme.com or 415-555-2671. ' +
        'Senior role requiring AWS, TypeScript, and Kubernetes experience across teams.';
    const { queryArgs, bedrockUserMessage } = await runResearchAgentForTest(jd);
    expect(queryArgs.join(' ')).not.toContain('recruiter@acme.com');
    expect(bedrockUserMessage).not.toContain('recruiter@acme.com');
    expect(bedrockUserMessage).not.toContain('415-555-2671');
    expect(bedrockUserMessage).toContain('[EMAIL]');
});
```

Implement `runResearchAgentForTest` as a thin helper in the test that drives the existing exported research entrypoint with the file's existing mocks and captures (a) the args passed to the mocked `store.querySimilar`/`querySingleRds` and (b) the user message passed to the mocked `runAgent`/Converse. Match the existing test file's mock surface; do not invent new mocks if the file already exposes these.

- [ ] **Step 2: Run to verify it fails**

Run: `cd applications/job-strategist && npx jest src/agents/research-agent.test.ts -t "redacts PII from the job description" -v`
Expected: FAIL (email/phone still present in query/message).

- [ ] **Step 3: Implement**

In `applications/job-strategist/src/agents/research-agent.ts`:

1. Add `PiiScrubber` to the `@bedrock/shared` value import:

```typescript
import {
    runAgent,
    parseJsonResponse,
    InputSanitiser,
    PiiScrubber,
    BedrockReranker,
    RdsVectorStore,
    TitanEmbeddingProvider,
    log,
} from '@bedrock/shared';
```

2. Add a module-scoped singleton near the existing `inputSanitiser` instance:

```typescript
const piiScrubber = new PiiScrubber();
```

3. After the existing `const { sanitised, warnings, injectionDetected } = inputSanitiser.sanitiseWithWarnings(ctx.jobDescription);`, derive a redacted JD and use it for every downstream use (retrieval queries and the Bedrock message). Add:

```typescript
const jd = piiScrubber.scrub(sanitised).redacted;
```

Then replace each subsequent use of `sanitised` that flows to retrieval or Bedrock with `jd` (the `querySingleRds(...)` calls built from the JD, and the `buildResearchMessage(...)` call). Leave injection/length warning logic on `sanitised` as-is.

4. Redact the query-preview log field. At the `log('INFO', 'Querying RDS vector store', { ... queryPreview: query.substring(0, 80) ... })` site, change to:

```typescript
queryPreview: piiScrubber.scrub(query.substring(0, 80)).redacted,
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd applications/job-strategist && npx jest src/agents/research-agent.test.ts -v`
Expected: PASS (all).

- [ ] **Step 5: Typecheck + commit**

Run: `cd applications/job-strategist && npx tsc --noEmit` (clean).

```
git add applications/job-strategist/src/agents/research-agent.ts applications/job-strategist/src/agents/research-agent.test.ts
git commit -m "feat(job-strategist): redact JD PII before retrieval, Bedrock, and logs"
```

---

## Task 4: job-strategist — grounding (block) at pipeline layer

**Files:** Modify `applications/job-strategist/src/run-pipeline.ts`; Test `applications/job-strategist/src/__tests__/run-pipeline.integration.test.ts` (append).

- [ ] **Step 1: Write the failing test**

Append to the integration test (it already drives the pipeline with mocks). Mock `BedrockGroundingVerifier` so `verify` is controllable. Assert block substitution and fail-open:

```typescript
it('substitutes fallback when strategist output is NOT_GROUNDED (block)', async () => {
    groundingVerifyMock.mockResolvedValueOnce({
        status: 'NOT_GROUNDED', reason: 'r', ungroundedClaims: [], answer: 'FALLBACK',
    });
    const out = await runPipelineForTest(/* existing happy-path inputs */);
    expect(out.analysis).toContain('FALLBACK');
});

it('does not hard-fail when the grounding verifier throws', async () => {
    groundingVerifyMock.mockRejectedValueOnce(new Error('bedrock down'));
    await expect(runPipelineForTest(/* existing happy-path inputs */)).resolves.toBeDefined();
});
```

`runPipelineForTest` = the existing harness the integration test already uses to invoke the pipeline (reuse it; do not rebuild). `groundingVerifyMock` mirrors the file's existing mock-construction pattern for agents.

- [ ] **Step 2: Run to verify it fails**

Run: `cd applications/job-strategist && npx jest src/__tests__/run-pipeline.integration.test.ts -t "NOT_GROUNDED" -v`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `applications/job-strategist/src/run-pipeline.ts`:

1. Import + singleton:

```typescript
import { BedrockGroundingVerifier } from '@bedrock/shared';
const groundingVerifier = new BedrockGroundingVerifier({ mode: 'block' });
```

2. After the strategist agent produces its analysis and the research KB context is available in scope, and BEFORE the analysis is persisted/returned, insert a fail-open block verify. Use the deduped research KB context already passed to the strategist (the same value the research result exposes — locate the variable holding the strategist input's `research.kbContext` or equivalent) split into chunks:

```typescript
const contextChunks = (researchResult.kbContext ?? '')
    .split('\n\n---\n\n')
    .filter(s => s.trim().length > 0);
let finalAnalysis = strategistResult.analysisXml;
try {
    const g = await groundingVerifier.verify({
        query: `${strategistResult.targetRole ?? ''} ${strategistResult.targetCompany ?? ''}`.trim(),
        contextChunks,
        answer: strategistResult.analysisXml,
    });
    finalAnalysis = g.answer;
} catch (e) {
    log('WARN', 'Grounding verifier failed — keeping original analysis', {
        error: (e as Error).message,
    });
}
```

Then use `finalAnalysis` wherever `strategistResult.analysisXml` was previously persisted/returned. Adjust the property names (`analysisXml`, `kbContext`, `targetRole`, `targetCompany`) to the actual fields on the pipeline's result objects — read them in `run-pipeline.ts`/the strategist result type and use the real names; do not introduce new fields.

- [ ] **Step 4: Run to verify it passes**

Run: `cd applications/job-strategist && npx jest src/__tests__/run-pipeline.integration.test.ts -v`
Expected: PASS (all).

- [ ] **Step 5: Typecheck + commit**

Run: `cd applications/job-strategist && npx tsc --noEmit` (clean).

```
git add applications/job-strategist/src/run-pipeline.ts applications/job-strategist/src/__tests__/run-pipeline.integration.test.ts
git commit -m "feat(job-strategist): grounding verify (block) at pipeline, fail-open"
```

---

## Task 5: ingestion — PII scrub at collection + before vector persist

**Files:** Modify `applications/ingestion/src/agents/ProfileInputCollector.ts`, `applications/ingestion/src/repositories/RepositoryProfileEmbeddingsRepository.ts`; Test `applications/ingestion/src/agents/__tests__/ProfileInputCollector.test.ts` (create if absent, else append).

- [ ] **Step 1: Write the failing test**

Create `applications/ingestion/src/agents/__tests__/ProfileInputCollector.test.ts` (if the dir/file doesn't exist, create it; mock the GitHub adapter the collector uses — follow the pattern in `src/util/__tests__/FileFetchCache.test.ts` for jest setup):

```typescript
import { ProfileInputCollector } from '../ProfileInputCollector.js';

describe('ProfileInputCollector PII scrubbing', () => {
    it('redacts PII from README and commit messages in the collected bundle', async () => {
        const collector = makeCollectorWithStubbedAdapter({
            readme: 'Maintainer: jane@corp.com — see notes',
            commits: ['fix by john@corp.com', 'normal commit'],
        });
        const bundle = await collector.collect('owner/repo');
        expect(JSON.stringify(bundle)).not.toContain('jane@corp.com');
        expect(JSON.stringify(bundle)).not.toContain('john@corp.com');
        expect(bundle.readme ?? '').toContain('[EMAIL]');
    });
});
```

`makeCollectorWithStubbedAdapter` = a small in-test factory that constructs `ProfileInputCollector` with its file-fetch dependency stubbed to return the given README/commits (inspect the real constructor signature and stub exactly what it needs — do not change production constructor shape).

- [ ] **Step 2: Run to verify it fails**

Run: `cd applications/ingestion && npx jest src/agents/__tests__/ProfileInputCollector.test.ts -v`
Expected: FAIL (emails present in bundle).

- [ ] **Step 3: Implement**

1. `applications/ingestion/src/agents/ProfileInputCollector.ts`: add import + singleton:

```typescript
import { PiiScrubber } from '@bedrock/shared';
const piiScrubber = new PiiScrubber();
```

In `collect()`, immediately before the `return { ... }`, scrub every user-controlled string field. Replace the returned values:

```typescript
const scrub = (s: string | null | undefined): string | null =>
    s == null ? (s ?? null) : piiScrubber.scrub(s).redacted;
return {
    repo_full_name: repoFullName,
    readme: scrub(readme),
    manifests: Object.fromEntries(
        Object.entries(manifests).map(([k, v]) => [k, piiScrubber.scrub(v).redacted]),
    ),
    changelog: scrub(changelog),
    workflows: Object.fromEntries(
        Object.entries(workflows).map(([k, v]) => [k, piiScrubber.scrub(v).redacted]),
    ),
    recent_commit_messages: commits.map(c => piiScrubber.scrub(c.message).redacted),
    // ...preserve any other existing fields exactly as before...
};
```

Match the EXACT field names and the exact set of fields the current `collect()` returns — read the function and the `ProfileInputBundle` type first; only redact the string/string-map/string-array fields, leave non-text fields untouched.

2. `applications/ingestion/src/repositories/RepositoryProfileEmbeddingsRepository.ts`: defence-in-depth in `upsertBatch()` — scrub `row.content` before it is pushed into `values` AND before the content hash, so the hash matches the stored text:

```typescript
import { PiiScrubber } from '@bedrock/shared';
const piiScrubber = new PiiScrubber();
// inside the per-row loop, replace row.content usage:
const scrubbedContent = piiScrubber.scrub(row.content).redacted;
// ...push scrubbedContent where row.content was used, and sha256(scrubbedContent)
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd applications/ingestion && npx jest src/agents/__tests__/ProfileInputCollector.test.ts -v`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `cd applications/ingestion && npx tsc --noEmit` (clean).

```
git add applications/ingestion/src/agents/ProfileInputCollector.ts applications/ingestion/src/repositories/RepositoryProfileEmbeddingsRepository.ts applications/ingestion/src/agents/__tests__/ProfileInputCollector.test.ts
git commit -m "feat(ingestion): redact PII at collection and before vector persist"
```

---

## Task 6: resume-import — PII scrub at all sinks

**Files:** Modify `applications/resume-import-processor/src/bedrock/extract-career.ts`, `src/bedrock/enrich-role.ts`, `src/tools/tavily-cache.ts`, `src/embed.ts`, `src/run-import.ts`; Test `applications/resume-import-processor/src/bedrock/__tests__/extract-career.test.ts` (create/append) and reuse `src/bedrock/__tests__/enrich-role.test.ts`.

- [ ] **Step 1: Write the failing tests**

Add a test asserting the resume text reaching the Bedrock request body is redacted. In `applications/resume-import-processor/src/bedrock/__tests__/extract-career.test.ts` (create if absent; mock the Bedrock client like `enrich-role.test.ts` does):

```typescript
it('redacts PII from resume text before the Bedrock request body', async () => {
    const sendMock = getMockedBedrockSend(); // however enrich-role.test mocks it
    await extractCareerData('John Doe, john.doe@mail.com, SSN 123-45-6789. Senior Engineer...', 'eu-west-1');
    const body = JSON.parse(sendMock.mock.calls.at(-1)?.[0].input.body);
    const sent = JSON.stringify(body);
    expect(sent).not.toContain('john.doe@mail.com');
    expect(sent).not.toContain('123-45-6789');
    expect(sent).toContain('[EMAIL]');
});
```

Match the real exported function name/signature in `extract-career.ts` and the mock approach used by the existing `enrich-role.test.ts`.

- [ ] **Step 2: Run to verify it fails**

Run: `cd applications/resume-import-processor && npx jest src/bedrock/__tests__/extract-career.test.ts -v`
Expected: FAIL.

- [ ] **Step 3: Implement (each sink; one shared singleton per file)**

Add `import { PiiScrubber } from '@bedrock/shared';` and `const piiScrubber = new PiiScrubber();` at module scope in each file below, then:

- `extract-career.ts`: scrub before truncation —
  `const safeText = piiScrubber.scrub(resumeText).redacted.slice(0, MAX_RESUME_CHARS);`
  (replace the existing `const safeText = resumeText.slice(0, MAX_RESUME_CHARS);`).
- `enrich-role.ts`: scrub title/company before the Tavily query build —
  ```typescript
  const t = piiScrubber.scrub(experience.title).redacted;
  const c = piiScrubber.scrub(experience.company).redacted;
  const query = `${t} responsibilities ${c} job description`;
  ```
  and redact `query`/`title` in the `log.warn`/`log.info` calls (`query: piiScrubber.scrub(query).redacted`, `title: piiScrubber.scrub(experience.title).redacted`).
- `tavily-cache.ts`: scrub the query before key derivation/normalise so cache key is deterministic on redacted text — at the start of `search()`:
  `const q = piiScrubber.scrub(query).redacted;` then use `q` for `cacheKey(q, ...)`, the inner search, and `normaliseQuery(q)` in the INSERT.
- `embed.ts`: scrub each highlight at chunk build —
  `content: piiScrubber.scrub(highlight).redacted` in the `achievement` chunk push (so `content_hash` is computed on redacted text).
- `run-import.ts`: scrub error JSON before DB writes — wrap the `error_details` value: `piiScrubber.scrub(JSON.stringify(extras.errorDetails)).redacted` and `JSON.stringify({ message: piiScrubber.scrub((err as Error).message).redacted })` at both error-write sites. Apply the same `{ message: scrubbed }` change in `run-enrichment.ts` if that file has the identical error-write.

- [ ] **Step 4: Run to verify it passes**

Run: `cd applications/resume-import-processor && npx jest src/bedrock/__tests__/extract-career.test.ts src/bedrock/__tests__/enrich-role.test.ts -v`
Expected: PASS (new test + existing enrich-role tests still green).

- [ ] **Step 5: Typecheck + commit**

Run: `cd applications/resume-import-processor && npx tsc --noEmit` (clean).

```
git add applications/resume-import-processor/src/bedrock/extract-career.ts applications/resume-import-processor/src/bedrock/enrich-role.ts applications/resume-import-processor/src/tools/tavily-cache.ts applications/resume-import-processor/src/embed.ts applications/resume-import-processor/src/run-import.ts applications/resume-import-processor/src/bedrock/__tests__/extract-career.test.ts
git commit -m "feat(resume-import): redact PII before Bedrock, Tavily, embeddings, and DB"
```

(Include `src/run-enrichment.ts` in the add only if it was modified.)

---

## Task 7: resume-import — grounding (flag) on gap analysis

**Files:** Modify `applications/resume-import-processor/src/bedrock/gap-analysis.ts`, `src/run-import.ts`; Test `applications/resume-import-processor/src/bedrock/__tests__/gap-analysis.test.ts` (create/append).

- [ ] **Step 1: Write the failing test**

```typescript
it('attaches grounding metadata per role and never blocks (flag mode)', async () => {
    groundingVerifyMock.mockResolvedValue({
        status: 'NOT_GROUNDED', reason: 'unsupported', ungroundedClaims: ['inflated bullet'],
        answer: 'ORIGINAL',
    });
    const result = await generateGapAnalysis(sampleRoles(), 0, 'eu-west-1');
    expect(result.data).toBeDefined();                 // report unchanged (not blocked)
    expect(result.groundingMetadata?.length ?? 0).toBeGreaterThan(0);
    expect(result.groundingMetadata?.[0].status).toBe('NOT_GROUNDED');
});
```

Mock `BedrockGroundingVerifier` (mirror the Bedrock mock pattern already in resume-import tests). `sampleRoles()` = minimal valid `GapAnalysisRole[]` (read the type; build the smallest fixture that exercises `perRole`).

- [ ] **Step 2: Run to verify it fails**

Run: `cd applications/resume-import-processor && npx jest src/bedrock/__tests__/gap-analysis.test.ts -v`
Expected: FAIL (`groundingMetadata` undefined).

- [ ] **Step 3: Implement**

In `applications/resume-import-processor/src/bedrock/gap-analysis.ts`:

1. Import + add `groundingMetadata?: GroundingResult[]` to the `GapAnalysisResult` interface:

```typescript
import { BedrockGroundingVerifier } from '@bedrock/shared';
import type { GroundingResult } from '@bedrock/shared';
```

2. After the report is produced (the single-call and merged paths converge on a `report`/result object that has `data.perRole`), run a flag-mode verify per role and attach. Do NOT alter `report.data`:

```typescript
const verifier = new BedrockGroundingVerifier({ mode: 'flag' });
const groundingMetadata: GroundingResult[] = [];
for (const perRole of report.data.perRole) {
    const roleData = roles.find(r => r.roleId === perRole.roleId);
    if (!roleData) continue;
    const contextChunks = [
        ...roleData.experience.highlights,
        ...((roleData.publicContext ?? []).map(p => p.content)),
    ];
    const answer = perRole.suggestedAdditions
        .map(s => `${s.bullet} (${s.rationale})`).join('\n');
    try {
        groundingMetadata.push(await verifier.verify({
            query: `gap suggestions for ${roleData.experience.title}`,
            contextChunks, answer,
        }));
    } catch (e) {
        log.warn?.({ event: 'gap_grounding.failed', err: (e as Error).message },
            'grounding verify failed; continuing');
    }
}
return { ...report, groundingMetadata };
```

Adjust field names (`roleId`, `experience.highlights`, `publicContext`, `suggestedAdditions`, `bullet`, `rationale`) to the real types — read `GapAnalysisRole`/`GapAnalysisReport`; use the actual names. Keep the existing return fields (`data`, `inputTokens`, `outputTokens`) intact via the spread.

3. In `applications/resume-import-processor/src/run-import.ts`, where `gap_report` is persisted (`JSON.stringify(gap.data)`), wrap the payload to include metadata — **no migration**:

```typescript
const gapPayload = {
    report: gap.data,
    groundingMetadata: gap.groundingMetadata ?? [],
    verifiedAt: new Date().toISOString(),
};
// replace JSON.stringify(gap.data) with JSON.stringify(gapPayload)
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd applications/resume-import-processor && npx jest src/bedrock/__tests__/gap-analysis.test.ts -v`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `cd applications/resume-import-processor && npx tsc --noEmit` (clean). Also run the wider suite: `npx jest --config ../jest.config.js src` — confirm no regressions.

```
git add applications/resume-import-processor/src/bedrock/gap-analysis.ts applications/resume-import-processor/src/run-import.ts applications/resume-import-processor/src/bedrock/__tests__/gap-analysis.test.ts
git commit -m "feat(resume-import): flag-mode grounding on gap analysis, metadata in gap_report"
```

---

## Task 8: article-pipeline — PII scrub draft input + MDX output

**Files:** Modify `applications/article-pipeline/src/agents/research-agent.ts`, `applications/article-pipeline/src/run-pipeline.ts`; Test `applications/article-pipeline/src/agents/__tests__/research-agent-retrieval.test.ts` (append) or a new colocated test.

- [ ] **Step 1: Write the failing test**

Add a test asserting the draft passed downstream is redacted. Reuse the retrieval test's mocks:

```typescript
it('redacts PII from the author draft before KB query and Bedrock', async () => {
    const { querySpy, researchUserMessage } = await runResearchForTest(
        'Draft by author@example.com about serverless. Phone 415-555-2671.',
    );
    expect(researchUserMessage).not.toContain('author@example.com');
    expect(researchUserMessage).not.toContain('415-555-2671');
    expect(researchUserMessage).toContain('[EMAIL]');
});
```

`runResearchForTest` reuses the existing retrieval test harness/mocks to drive the research agent and capture the user message + query args.

- [ ] **Step 2: Run to verify it fails**

Run: `cd applications/article-pipeline && npx jest src/agents/__tests__/research-agent-retrieval.test.ts -t "redacts PII from the author draft" -v`
Expected: FAIL.

- [ ] **Step 3: Implement**

1. `applications/article-pipeline/src/agents/research-agent.ts`: import + singleton; scrub immediately after the S3 read:

```typescript
import { PiiScrubber } from '@bedrock/shared';
const piiScrubber = new PiiScrubber();
// ...
const draftContent = piiScrubber.scrub(
    await readDraftFromS3(ctx.bucket, ctx.sourceKey),
).redacted;
```

Use `draftContent` (now redacted) for all existing downstream uses (KB query, author-direction extraction, research message).

2. `applications/article-pipeline/src/run-pipeline.ts`: import + singleton; scrub the MDX before persist:

```typescript
import { PiiScrubber } from '@bedrock/shared';
const piiScrubber = new PiiScrubber();
// ...
await persistArticle(pool, env.slug, piiScrubber.scrub(writer.data.content).redacted);
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd applications/article-pipeline && npx jest src/agents/__tests__/research-agent-retrieval.test.ts -v`
Expected: PASS (all).

- [ ] **Step 5: Typecheck + commit**

Run: `cd applications/article-pipeline && npx tsc --noEmit` (clean).

```
git add applications/article-pipeline/src/agents/research-agent.ts applications/article-pipeline/src/run-pipeline.ts applications/article-pipeline/src/agents/__tests__/research-agent-retrieval.test.ts
git commit -m "feat(article-pipeline): redact PII from draft input and article output"
```

---

## Task 9: article-pipeline — grounding (flag) post-QA + EMF

**Files:** Modify `applications/article-pipeline/src/run-pipeline.ts`; Test `applications/article-pipeline/src/__tests__/run-pipeline.test.ts` (create/append — if no pipeline test exists, create one mocking the agents + pool like the existing agent tests do).

- [ ] **Step 1: Write the failing test**

```typescript
it('runs flag-mode grounding post-QA, never blocks, emits metric', async () => {
    groundingVerifyMock.mockResolvedValueOnce({
        status: 'NOT_GROUNDED', reason: 'r', ungroundedClaims: ['c'], answer: 'MDX',
    });
    const { persistedContent, emitted } = await runPipelineForTest(/* happy path */);
    expect(persistedContent).toBe(/* the original writer MDX, unchanged */ expectedMdx);
    expect(emitted).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'GroundingFailed', value: 1 }),
    ]));
});

it('does not hard-fail when the grounding verifier throws', async () => {
    groundingVerifyMock.mockRejectedValueOnce(new Error('bedrock down'));
    await expect(runPipelineForTest(/* happy path */)).resolves.toBeDefined();
});
```

Capture emitted EMF by mocking `emitEmfMetric` from `@bedrock/shared` (follow how the shared grounding test mocked `../emf.js`; here mock the named export on `@bedrock/shared`).

- [ ] **Step 2: Run to verify it fails**

Run: `cd applications/article-pipeline && npx jest src/__tests__/run-pipeline.test.ts -v`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `applications/article-pipeline/src/run-pipeline.ts` add import + singleton:

```typescript
import { BedrockGroundingVerifier, emitEmfMetric } from '@bedrock/shared';
const groundingVerifier = new BedrockGroundingVerifier({ mode: 'flag' });
```

Between QA completion and `persistArticle(...)`, insert a fail-open flag verify + EMF; do NOT change the persisted content (flag mode):

```typescript
try {
    const g = await groundingVerifier.verify({
        query: research.data.draftContent.slice(0, 500),
        contextChunks: research.data.kbPassages.map(p => p.text),
        answer: writer.data.content,
    });
    emitEmfMetric('ArticlePipeline', { Stage: 'grounding', Status: g.status }, [
        { name: 'GroundingChecked', value: 1, unit: 'Count' },
        { name: 'GroundingFailed', value: g.status === 'NOT_GROUNDED' ? 1 : 0, unit: 'Count' },
        { name: 'UngroundedClaimCount', value: g.ungroundedClaims.length, unit: 'Count' },
    ]);
    groundingMeta = {
        status: g.status, reason: g.reason, ungroundedClaims: g.ungroundedClaims,
    };
} catch (e) {
    emitEmfMetric('ArticlePipeline', { Stage: 'grounding', Status: 'ERROR' },
        [{ name: 'GroundingError', value: 1, unit: 'Count' }]);
    log('WARN', 'Grounding verifier failed — proceeding', { error: (e as Error).message });
}
await persistArticle(pool, env.slug, /* existing redacted content arg from Task 8 */);
```

Attach `groundingMeta` into the existing pipeline-run update JSON (the `updatePipelineRun(...)` call) — add a `grounding` key to whatever metadata object it already persists; **no migration**. Use the real field names from `research.data` (`draftContent`, `kbPassages`, `.text`) — confirm against the research result type and adjust if names differ.

- [ ] **Step 4: Run to verify it passes**

Run: `cd applications/article-pipeline && npx jest src/__tests__/run-pipeline.test.ts -v`
Expected: PASS (all).

- [ ] **Step 5: Typecheck + commit**

Run: `cd applications/article-pipeline && npx tsc --noEmit` (clean).

```
git add applications/article-pipeline/src/run-pipeline.ts applications/article-pipeline/src/__tests__/run-pipeline.test.ts
git commit -m "feat(article-pipeline): flag-mode grounding post-QA with EMF, fail-open"
```

---

## Task 10: Final verification + push

- [ ] **Step 1: Per-app suites + typecheck**

Run each, expect all green / clean:
```
cd applications/chatbot && npx jest && npx tsc --noEmit
cd applications/job-strategist && npx jest && npx tsc --noEmit
cd applications/ingestion && npx jest && npx tsc --noEmit
cd applications/resume-import-processor && npx jest --config ../jest.config.js src && npx tsc --noEmit
cd applications/article-pipeline && npx jest && npx tsc --noEmit
```

- [ ] **Step 2: Shared suite unaffected**

Run: `cd applications/shared && npx jest && npx tsc --noEmit`
Expected: still 177+ pass, clean (no shared code changed this sub-project — confirm).

- [ ] **Step 3: Scope guard**

Run: `git diff --name-only feat/rag-shared-safety...HEAD`
Expected: only files under `applications/{chatbot,job-strategist,ingestion,resume-import-processor,article-pipeline}/src/` plus the two root sub-project-2 docs. No `applications/shared/src` changes, no infra/migration unless an unavoidable idempotent migration was added (flagged in its task).

- [ ] **Step 4: Push**

```
git push -u origin feat/rag-sp2-app-wiring
```

- [ ] **Step 5: Report**

Summarise: per-app sinks wired, grounding modes applied, fail-open verified, all suites green, scope guard result, branch pushed. Offer to open a PR (base `develop`, noting it stacks on PR #4).

---

## Self-Review

**Spec coverage:** chatbot PII→T1, chatbot grounding→T2, job-strategist PII→T3, job-strategist grounding→T4, ingestion PII→T5, resume-import PII→T6, resume-import grounding→T7, article-pipeline PII→T8, article-pipeline grounding→T9, fail-open behaviour→T2/T4/T7/T9, no-migration metadata→T7/T9, verification+scope guard→T10. All spec sections covered.

**Placeholder scan:** No TBD/TODO. Each task gives the import line, singleton, concrete before→after transformation, concrete test code, exact run commands, exact commit. Where exact line numbers/field names cannot be pinned without the live file, the task quotes the current code to locate and names the precise transformation + instructs confirming real field names — this is integration guidance, not a placeholder.

**Type consistency:** `PiiScrubber().scrub(x).redacted` (string) used uniformly. `BedrockGroundingVerifier({ mode })` + `verify({ query, contextChunks, answer })` → `{ status, reason, ungroundedClaims, answer }` used uniformly across T2/T4/T7/T9, matching sub-project 1's shipped types. `GroundingResult` imported as a type where persisted (T7). `emitEmfMetric(namespace, dimensions, metrics[])` matches the shared signature used in sub-project 1.

**Note for executor:** Apps differ in test-harness shape. Each task says to reuse the app's existing mocks/harness rather than invent new ones; if an app lacks a pipeline test entirely (article-pipeline T9), create one following the app's existing agent-test mocking style. Confirm real property names in result/types before finalising grounding wiring (T4/T7/T9) — do not introduce new fields.
