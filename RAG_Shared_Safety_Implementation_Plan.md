# RAG Shared Safety Modules — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build two shared safety modules — a redacting PII scrubber and a Bedrock grounding verifier — plus per-app split checklist docs and tracking GitHub issues, with no per-app wiring.

**Architecture:** Both modules are pure `@bedrock/shared` library code. The PII scrubber uses a pluggable `IPiiDetector` (regex default, Comprehend stub) and redacts to mask tokens. The grounding verifier runs the checklist §6 prompt on Claude Haiku 4.5 via the Bedrock Converse API, returning a discriminated `GROUNDED|NOT_GROUNDED` result with `block|flag` behaviour and EMF metrics. No app imports them this sub-project (that is sub-project 2, issue-driven).

**Tech Stack:** TypeScript (NodeNext, commonjs), ts-jest, `@aws-sdk/client-bedrock-runtime`, existing `emf.ts` emitter. Source spec: `RAG_Shared_Safety_Design_Review.md`.

---

## File Structure

PII scrubber (`applications/shared/src/security/`):
- `pii-types.ts` — `PiiType`, `PiiSpan`, `RedactionPolicy`, `IPiiDetector`
- `regex-pii-detector.ts` — `RegexPiiDetector`
- `comprehend-pii-detector.ts` — `ComprehendPiiDetector` throwing stub
- `pii-scrubber.ts` — `PiiScrubber`
- `pii-scrubber.test.ts`, `regex-pii-detector.test.ts` — colocated tests
- `index.ts` — extend barrel exports

Grounding verifier (new `applications/shared/src/grounding/`):
- `grounding-types.ts` — `GroundingInput`, `GroundingResult`, `GroundingMode`, `IGroundingVerifier`
- `bedrock-grounding-verifier.ts` — `BedrockGroundingVerifier`
- `bedrock-grounding-verifier.test.ts` — colocated test
- `index.ts` — barrel
- `applications/shared/src/index.ts` — add grounding export

Docs (repo root — `docs/` is gitignored):
- `rag-checklist/README.md` + `chatbot.md`, `job-strategist.md`, `ingestion.md`, `resume-import.md`, `article-pipeline.md`

All commands run from `applications/shared` unless stated. Test command: `npx jest <path> -v`. Commits follow the **git-commit skill** (tests + `npm run typecheck` green, atomic, no AI authorship trailer).

---

## Task 1: PII types and detector interface

**Files:**
- Create: `applications/shared/src/security/pii-types.ts`

- [ ] **Step 1: Write the types file**

```typescript
/**
 * @format
 * PII types — shared contract for detection + redaction.
 *
 * Mirrors the storage-agnostic IReranker pattern: one interface, swappable
 * implementations (RegexPiiDetector now, ComprehendPiiDetector later).
 */

export type PiiType =
    | 'EMAIL'
    | 'PHONE'
    | 'SSN'
    | 'CREDIT_CARD'
    | 'IP'
    | 'NAME';

export interface PiiSpan {
    /** Inclusive start offset in the source string. */
    readonly start: number;
    /** Exclusive end offset in the source string. */
    readonly end: number;
    readonly type: PiiType;
    /** The matched substring (for logging/tests; never re-emitted to sinks). */
    readonly value: string;
}

/** Maps each PII type to its mask token. */
export type RedactionPolicy = Readonly<Record<PiiType, string>>;

export const DEFAULT_REDACTION_POLICY: RedactionPolicy = {
    EMAIL: '[EMAIL]',
    PHONE: '[PHONE]',
    SSN: '[SSN]',
    CREDIT_CARD: '[CC]',
    IP: '[IP]',
    NAME: '[NAME]',
};

export interface IPiiDetector {
    /** Return all PII spans found in `text`, in ascending start order. */
    detect(text: string): PiiSpan[];
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS (no errors).

- [ ] **Step 3: Commit**

```
git add applications/shared/src/security/pii-types.ts
git commit -m "feat(shared-security): add PII detector types and contract"
```

---

## Task 2: RegexPiiDetector

**Files:**
- Create: `applications/shared/src/security/regex-pii-detector.ts`
- Test: `applications/shared/src/security/regex-pii-detector.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { RegexPiiDetector } from './regex-pii-detector.js';

describe('RegexPiiDetector', () => {
    const d = new RegexPiiDetector();

    it('detects an email with correct span and type', () => {
        const text = 'reach me at jane.doe@example.com today';
        const spans = d.detect(text);
        expect(spans).toHaveLength(1);
        expect(spans[0].type).toBe('EMAIL');
        expect(spans[0].value).toBe('jane.doe@example.com');
        expect(text.slice(spans[0].start, spans[0].end)).toBe('jane.doe@example.com');
    });

    it('detects phone, SSN, credit card, and IPv4', () => {
        const text = 'call 415-555-2671, ssn 123-45-6789, cc 4111 1111 1111 1111, ip 10.0.0.1';
        const types = d.detect(text).map(s => s.type).sort();
        expect(types).toEqual(['CREDIT_CARD', 'IP', 'PHONE', 'SSN']);
    });

    it('detects a NAME via name-context heuristic only', () => {
        const spans = d.detect('Name: Nelson Lamounier');
        expect(spans.some(s => s.type === 'NAME' && s.value === 'Nelson Lamounier')).toBe(true);
        // bare capitalised bigram with no name context is NOT flagged (low-recall by design)
        expect(d.detect('Cloud Engineering team').some(s => s.type === 'NAME')).toBe(false);
    });

    it('returns spans in ascending start order and [] for clean text', () => {
        expect(d.detect('no pii here')).toEqual([]);
        const spans = d.detect('a@b.com then 10.0.0.1');
        expect(spans[0].start).toBeLessThan(spans[1].start);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/security/regex-pii-detector.test.ts -v`
Expected: FAIL — cannot find module `./regex-pii-detector.js`.

- [ ] **Step 3: Write the implementation**

```typescript
/**
 * @format
 * RegexPiiDetector — deterministic, zero-infra default IPiiDetector.
 *
 * Best-effort. The NAME heuristic is deliberately low-recall (only
 * capitalised bigrams adjacent to a name-context keyword) to avoid
 * over-redacting ordinary capitalised phrases. ML-grade name detection
 * is the ComprehendPiiDetector's job (see GitHub issue).
 */

import type { IPiiDetector, PiiSpan, PiiType } from './pii-types.js';

interface Rule {
    readonly type: PiiType;
    readonly regex: RegExp;
}

const RULES: ReadonlyArray<Rule> = [
    { type: 'EMAIL', regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
    { type: 'SSN', regex: /\b\d{3}-\d{2}-\d{4}\b/g },
    { type: 'CREDIT_CARD', regex: /\b(?:\d[ -]*?){13,16}\b/g },
    { type: 'PHONE', regex: /\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/g },
    { type: 'IP', regex: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g },
    // NAME: capitalised bigram immediately preceded by a name-context keyword.
    { type: 'NAME', regex: /(?<=\b(?:name|candidate|applicant|by)\b[:\s]+)[A-Z][a-z]+ [A-Z][a-z]+/g },
];

export class RegexPiiDetector implements IPiiDetector {
    detect(text: string): PiiSpan[] {
        const spans: PiiSpan[] = [];
        for (const { type, regex } of RULES) {
            regex.lastIndex = 0;
            let m: RegExpExecArray | null;
            while ((m = regex.exec(text)) !== null) {
                spans.push({ start: m.index, end: m.index + m[0].length, type, value: m[0] });
                if (m[0].length === 0) regex.lastIndex++;
            }
        }
        return spans.sort((a, b) => a.start - b.start);
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/security/regex-pii-detector.test.ts -v`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```
git add applications/shared/src/security/regex-pii-detector.ts applications/shared/src/security/regex-pii-detector.test.ts
git commit -m "feat(shared-security): add RegexPiiDetector with TDD coverage"
```

---

## Task 3: ComprehendPiiDetector stub

**Files:**
- Create: `applications/shared/src/security/comprehend-pii-detector.ts`

- [ ] **Step 1: Write the stub**

```typescript
/**
 * @format
 * ComprehendPiiDetector — placeholder for Amazon Comprehend DetectPiiEntities.
 *
 * Implements IPiiDetector so apps can swap detectors without rewiring.
 * NOT implemented in sub-project 1 — tracked by the shared PII GitHub issue.
 */

import type { IPiiDetector, PiiSpan } from './pii-types.js';

export class ComprehendPiiDetector implements IPiiDetector {
    detect(_text: string): PiiSpan[] {
        throw new Error(
            'ComprehendPiiDetector not implemented — see the shared PII scrubber ' +
            'GitHub issue. Use RegexPiiDetector until Comprehend is wired in.',
        );
    }
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```
git add applications/shared/src/security/comprehend-pii-detector.ts
git commit -m "feat(shared-security): add ComprehendPiiDetector stub"
```

---

## Task 4: PiiScrubber

**Files:**
- Create: `applications/shared/src/security/pii-scrubber.ts`
- Test: `applications/shared/src/security/pii-scrubber.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { PiiScrubber } from './pii-scrubber.js';
import type { IPiiDetector, PiiSpan } from './pii-types.js';

describe('PiiScrubber', () => {
    it('redacts detected spans with default policy tokens', () => {
        const s = new PiiScrubber();
        const r = s.scrub('email jane@x.com and ip 10.0.0.1');
        expect(r.found).toBe(true);
        expect(r.redacted).toBe('email [EMAIL] and ip [IP]');
        expect(r.spans.map(x => x.type).sort()).toEqual(['EMAIL', 'IP']);
    });

    it('returns input unchanged and found=false when no PII', () => {
        const r = new PiiScrubber().scrub('totally clean text');
        expect(r).toEqual({ redacted: 'totally clean text', spans: [], found: false });
    });

    it('handles adjacent spans without corrupting offsets', () => {
        const fake: IPiiDetector = {
            detect: (): PiiSpan[] => [
                { start: 0, end: 5, type: 'NAME', value: 'Alice' },
                { start: 6, end: 18, type: 'EMAIL', value: 'a@example.io' },
            ],
        };
        const r = new PiiScrubber({ detector: fake }).scrub('Alice a@example.io');
        expect(r.redacted).toBe('[NAME] [EMAIL]');
    });

    it('honours a custom redaction policy', () => {
        const r = new PiiScrubber({ policy: { EMAIL: '<<E>>', PHONE: '[PHONE]', SSN: '[SSN]', CREDIT_CARD: '[CC]', IP: '[IP]', NAME: '[NAME]' } })
            .scrub('a@b.com');
        expect(r.redacted).toBe('<<E>>');
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/security/pii-scrubber.test.ts -v`
Expected: FAIL — cannot find module `./pii-scrubber.js`.

- [ ] **Step 3: Write the implementation**

```typescript
/**
 * @format
 * PiiScrubber — standalone redactor. Run before EVERY sink that can leak
 * PII: the LLM call, the DB write, and the log line. Deliberately separate
 * from InputSanitiser (which only warns and only sees the input flow).
 */

import { RegexPiiDetector } from './regex-pii-detector.js';
import {
    DEFAULT_REDACTION_POLICY,
    type IPiiDetector,
    type PiiSpan,
    type RedactionPolicy,
} from './pii-types.js';

export interface PiiScrubberConfig {
    /** Detector to use. Default: RegexPiiDetector. */
    readonly detector?: IPiiDetector;
    /** Mask-token policy. Default: DEFAULT_REDACTION_POLICY. */
    readonly policy?: RedactionPolicy;
}

export interface PiiScrubResult {
    readonly redacted: string;
    readonly spans: PiiSpan[];
    readonly found: boolean;
}

export class PiiScrubber {
    private readonly detector: IPiiDetector;
    private readonly policy: RedactionPolicy;

    constructor(config?: PiiScrubberConfig) {
        this.detector = config?.detector ?? new RegexPiiDetector();
        this.policy = config?.policy ?? DEFAULT_REDACTION_POLICY;
    }

    scrub(text: string): PiiScrubResult {
        const spans = [...this.detector.detect(text)].sort((a, b) => a.start - b.start);
        if (spans.length === 0) {
            return { redacted: text, spans: [], found: false };
        }
        // Apply right-to-left so earlier offsets stay valid.
        let redacted = text;
        for (let i = spans.length - 1; i >= 0; i--) {
            const sp = spans[i];
            redacted = redacted.slice(0, sp.start) + this.policy[sp.type] + redacted.slice(sp.end);
        }
        return { redacted, spans, found: true };
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/security/pii-scrubber.test.ts -v`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```
git add applications/shared/src/security/pii-scrubber.ts applications/shared/src/security/pii-scrubber.test.ts
git commit -m "feat(shared-security): add PiiScrubber redactor with TDD coverage"
```

---

## Task 5: Adversarial fixtures + barrel export

**Files:**
- Modify: `applications/shared/src/security/index.ts`
- Test: `applications/shared/src/security/pii-scrubber.test.ts` (append)

- [ ] **Step 1: Append adversarial test cases**

Append inside the `describe('PiiScrubber', ...)` block in `pii-scrubber.test.ts`:

```typescript
    describe('adversarial inputs (checklist section 5)', () => {
        const s = new PiiScrubber();
        it('redacts spaced/dashed SSN and credit card variants', () => {
            expect(s.scrub('ssn 123-45-6789').redacted).toBe('ssn [SSN]');
            expect(s.scrub('card 4111-1111-1111-1111').found).toBe(true);
            expect(s.scrub('card 4111 1111 1111 1111').found).toBe(true);
        });
        it('redacts email with plus-addressing and subdomains', () => {
            expect(s.scrub('a.b+tag@mail.corp.example.co').redacted).toBe('[EMAIL]');
        });
        it('flags IP only with 4 octets, not version strings', () => {
            expect(s.scrub('build 1.2.3 shipped').found).toBe(false);
            expect(s.scrub('host 192.168.1.10').found).toBe(true);
        });
    });
```

- [ ] **Step 2: Run to verify new cases pass**

Run: `npx jest src/security/pii-scrubber.test.ts -v`
Expected: PASS (all PiiScrubber tests incl. adversarial).

- [ ] **Step 3: Extend the security barrel**

In `applications/shared/src/security/index.ts`, append after the existing exports (before end of file):

```typescript
export { PiiScrubber } from './pii-scrubber.js';
export type { PiiScrubberConfig, PiiScrubResult } from './pii-scrubber.js';
export { RegexPiiDetector } from './regex-pii-detector.js';
export { ComprehendPiiDetector } from './comprehend-pii-detector.js';
export { DEFAULT_REDACTION_POLICY } from './pii-types.js';
export type { IPiiDetector, PiiSpan, PiiType, RedactionPolicy } from './pii-types.js';
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```
git add applications/shared/src/security/index.ts applications/shared/src/security/pii-scrubber.test.ts
git commit -m "feat(shared-security): export PII scrubber API + adversarial tests"
```

---

## Task 6: Grounding types and interface

**Files:**
- Create: `applications/shared/src/grounding/grounding-types.ts`

- [ ] **Step 1: Write the types file**

```typescript
/**
 * @format
 * Grounding types — checklist section 6 self-correction contract.
 *
 * Verifies a generated answer is supported by its retrieved context.
 * Mode is per-app: query apps use 'block', pipeline apps use 'flag'.
 */

export type GroundingMode = 'block' | 'flag';

export interface GroundingInput {
    readonly query: string;
    readonly contextChunks: readonly string[];
    readonly answer: string;
}

export interface GroundingResult {
    readonly status: 'GROUNDED' | 'NOT_GROUNDED';
    readonly reason: string;
    readonly ungroundedClaims: readonly string[];
    /**
     * Answer to return to the caller. In 'flag' mode this is always the
     * original answer. In 'block' mode it is the fallback string when
     * status is NOT_GROUNDED, otherwise the original answer.
     */
    readonly answer: string;
}

export interface IGroundingVerifier {
    verify(input: GroundingInput): Promise<GroundingResult>;
}

export const DEFAULT_GROUNDING_FALLBACK =
    "I don't have enough grounded information to answer that confidently.";
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```
git add applications/shared/src/grounding/grounding-types.ts
git commit -m "feat(shared-grounding): add grounding verifier contract"
```

---

## Task 7: BedrockGroundingVerifier — verify + parse

**Files:**
- Create: `applications/shared/src/grounding/bedrock-grounding-verifier.ts`
- Test: `applications/shared/src/grounding/bedrock-grounding-verifier.test.ts`

- [ ] **Step 1: Write the failing test (Bedrock + emf mocked)**

```typescript
const sendMock = jest.fn();
jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
    BedrockRuntimeClient: jest.fn(() => ({ send: sendMock })),
    ConverseCommand: jest.fn((input) => ({ input })),
}));
const emitMock = jest.fn();
jest.mock('../emf.js', () => ({ emitEmfMetric: (...a: unknown[]) => emitMock(...a) }));

import { BedrockGroundingVerifier } from './bedrock-grounding-verifier.js';

function modelReply(text: string) {
    return { output: { message: { content: [{ text }] } } };
}

describe('BedrockGroundingVerifier', () => {
    const input = { query: 'q', contextChunks: ['ctx fact A'], answer: 'A is true' };

    it('parses a GROUNDED verdict and returns the original answer (flag mode)', async () => {
        sendMock.mockResolvedValueOnce(modelReply('GROUNDED\nReason: supported by ctx'));
        const v = new BedrockGroundingVerifier({ mode: 'flag' });
        const r = await v.verify(input);
        expect(r.status).toBe('GROUNDED');
        expect(r.answer).toBe('A is true');
        expect(r.ungroundedClaims).toEqual([]);
    });

    it('parses NOT_GROUNDED with claims and keeps answer in flag mode', async () => {
        sendMock.mockResolvedValueOnce(modelReply('NOT_GROUNDED\nReason: invented\nClaims: A is true'));
        const r = await new BedrockGroundingVerifier({ mode: 'flag' }).verify(input);
        expect(r.status).toBe('NOT_GROUNDED');
        expect(r.answer).toBe('A is true');
        expect(r.ungroundedClaims).toEqual(['A is true']);
    });

    it('defaults to NOT_GROUNDED on unparseable model output (fail-safe)', async () => {
        sendMock.mockResolvedValueOnce(modelReply('no verdict here'));
        const r = await new BedrockGroundingVerifier({ mode: 'flag' }).verify(input);
        expect(r.status).toBe('NOT_GROUNDED');
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/grounding/bedrock-grounding-verifier.test.ts -v`
Expected: FAIL — cannot find module `./bedrock-grounding-verifier.js`.

- [ ] **Step 3: Write the implementation**

```typescript
/**
 * @format
 * BedrockGroundingVerifier — checklist section 6 grounding check via Converse.
 *
 * Runs the source-vs-answer prompt on a cheap model (Haiku 4.5). Fail-safe:
 * any parse ambiguity resolves to NOT_GROUNDED so hallucinations are never
 * silently treated as grounded.
 */

import {
    BedrockRuntimeClient,
    ConverseCommand,
} from '@aws-sdk/client-bedrock-runtime';

import { emitEmfMetric } from '../emf.js';
import {
    DEFAULT_GROUNDING_FALLBACK,
    type GroundingInput,
    type GroundingMode,
    type GroundingResult,
    type IGroundingVerifier,
} from './grounding-types.js';

const DEFAULT_MODEL_ID =
    process.env.GROUNDING_MODEL_ID ?? 'eu.anthropic.claude-haiku-4-5-20251001-v1:0';
const METRIC_NAMESPACE = 'BedrockSharedSafety';

export interface BedrockGroundingVerifierConfig {
    readonly mode: GroundingMode;
    readonly modelId?: string;
    readonly fallback?: string;
    readonly client?: BedrockRuntimeClient;
}

function buildPrompt(i: GroundingInput): string {
    return [
        'Given the following source chunks:',
        i.contextChunks.map((c, n) => `[${n + 1}] ${c}`).join('\n'),
        '',
        'And the following generated answer:',
        i.answer,
        '',
        'Is every claim in the answer directly supported by the source chunks?',
        'Reply on the first line with exactly GROUNDED or NOT_GROUNDED.',
        'Then "Reason: <brief reason>".',
        'If NOT_GROUNDED, add "Claims: <semicolon-separated unsupported claims>".',
    ].join('\n');
}

function parse(text: string): { status: 'GROUNDED' | 'NOT_GROUNDED'; reason: string; claims: string[] } {
    const grounded = /\bGROUNDED\b/.test(text) && !/\bNOT_GROUNDED\b/.test(text);
    const reason = /Reason:\s*(.+)/i.exec(text)?.[1]?.trim() ?? '';
    const claimsRaw = /Claims:\s*(.+)/i.exec(text)?.[1]?.trim() ?? '';
    const claims = claimsRaw ? claimsRaw.split(';').map(c => c.trim()).filter(Boolean) : [];
    return { status: grounded ? 'GROUNDED' : 'NOT_GROUNDED', reason, claims };
}

export class BedrockGroundingVerifier implements IGroundingVerifier {
    private readonly mode: GroundingMode;
    private readonly modelId: string;
    private readonly fallback: string;
    private readonly client: BedrockRuntimeClient;

    constructor(config: BedrockGroundingVerifierConfig) {
        this.mode = config.mode;
        this.modelId = config.modelId ?? DEFAULT_MODEL_ID;
        this.fallback = config.fallback ?? DEFAULT_GROUNDING_FALLBACK;
        this.client = config.client ?? new BedrockRuntimeClient({});
    }

    async verify(input: GroundingInput): Promise<GroundingResult> {
        const command = new ConverseCommand({
            modelId: this.modelId,
            messages: [{ role: 'user', content: [{ text: buildPrompt(input) }] }],
            inferenceConfig: { maxTokens: 512 },
        });
        const response = await this.client.send(command);
        const text =
            response?.output?.message?.content?.find((b: { text?: string }) => typeof b.text === 'string')?.text ?? '';
        const { status, reason, claims } = parse(text);

        emitEmfMetric(
            METRIC_NAMESPACE,
            { Module: 'grounding', Mode: this.mode },
            [
                { name: 'GroundingChecked', value: 1, unit: 'Count' },
                { name: 'GroundingFailed', value: status === 'NOT_GROUNDED' ? 1 : 0, unit: 'Count' },
            ],
        );

        const answer =
            this.mode === 'block' && status === 'NOT_GROUNDED' ? this.fallback : input.answer;
        return { status, reason, ungroundedClaims: claims, answer };
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/grounding/bedrock-grounding-verifier.test.ts -v`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```
git add applications/shared/src/grounding/bedrock-grounding-verifier.ts applications/shared/src/grounding/bedrock-grounding-verifier.test.ts
git commit -m "feat(shared-grounding): add BedrockGroundingVerifier with TDD coverage"
```

---

## Task 8: block mode + EMF metric assertions

**Files:**
- Test: `applications/shared/src/grounding/bedrock-grounding-verifier.test.ts` (append)

- [ ] **Step 1: Append block-mode + metric tests**

Append inside the `describe('BedrockGroundingVerifier', ...)` block:

```typescript
    it('substitutes the fallback in block mode when NOT_GROUNDED', async () => {
        sendMock.mockResolvedValueOnce(modelReply('NOT_GROUNDED\nReason: invented'));
        const r = await new BedrockGroundingVerifier({ mode: 'block', fallback: 'NOPE' }).verify(input);
        expect(r.status).toBe('NOT_GROUNDED');
        expect(r.answer).toBe('NOPE');
    });

    it('keeps the answer in block mode when GROUNDED', async () => {
        sendMock.mockResolvedValueOnce(modelReply('GROUNDED\nReason: ok'));
        const r = await new BedrockGroundingVerifier({ mode: 'block' }).verify(input);
        expect(r.answer).toBe('A is true');
    });

    it('emits GroundingChecked=1 and GroundingFailed=1 on NOT_GROUNDED', async () => {
        sendMock.mockResolvedValueOnce(modelReply('NOT_GROUNDED\nReason: x'));
        await new BedrockGroundingVerifier({ mode: 'flag' }).verify(input);
        const metrics = emitMock.mock.calls.at(-1)?.[2];
        expect(metrics).toEqual([
            { name: 'GroundingChecked', value: 1, unit: 'Count' },
            { name: 'GroundingFailed', value: 1, unit: 'Count' },
        ]);
    });
```

- [ ] **Step 2: Run to verify it passes**

Run: `npx jest src/grounding/bedrock-grounding-verifier.test.ts -v`
Expected: PASS (6 tests total).

- [ ] **Step 3: Commit**

```
git add applications/shared/src/grounding/bedrock-grounding-verifier.test.ts
git commit -m "test(shared-grounding): cover block mode and EMF emission"
```

---

## Task 9: Grounding barrel + top-level shared export

**Files:**
- Create: `applications/shared/src/grounding/index.ts`
- Modify: `applications/shared/src/index.ts`

- [ ] **Step 1: Write the grounding barrel**

`applications/shared/src/grounding/index.ts`:

```typescript
/**
 * @format
 * Grounding — Public API. Checklist section 6 self-correction / answer grounding.
 */

export { BedrockGroundingVerifier } from './bedrock-grounding-verifier.js';
export type { BedrockGroundingVerifierConfig } from './bedrock-grounding-verifier.js';
export { DEFAULT_GROUNDING_FALLBACK } from './grounding-types.js';
export type {
    GroundingInput,
    GroundingMode,
    GroundingResult,
    IGroundingVerifier,
} from './grounding-types.js';
```

- [ ] **Step 2: Add to the top-level shared barrel**

Inspect `applications/shared/src/index.ts`. Find where sibling modules are re-exported (e.g. a line re-exporting `./security/index.js` or `./retrieval/index.js`) and add an analogous line:

```typescript
export * from './grounding/index.js';
```

If `./security/index.js` is NOT already re-exported there, also add:

```typescript
export * from './security/index.js';
```

- [ ] **Step 3: Typecheck + full shared test run**

Run: `npx tsc --noEmit && npx jest -v`
Expected: PASS — all shared tests green, no type errors.

- [ ] **Step 4: Commit**

```
git add applications/shared/src/grounding/index.ts applications/shared/src/index.ts
git commit -m "feat(shared-grounding): export grounding module from shared barrel"
```

---

## Task 10: Per-app split checklist docs

**Files:**
- Create: `rag-checklist/README.md`, `rag-checklist/chatbot.md`, `rag-checklist/job-strategist.md`, `rag-checklist/ingestion.md`, `rag-checklist/resume-import.md`, `rag-checklist/article-pipeline.md`

- [ ] **Step 1: Write `rag-checklist/README.md`**

Content (verbatim):

```markdown
# RAG Checklist — Split Model

`Rag-deployment-check-list.md` (repo root) is the canonical chatbot
checklist. It splits into two subsets applied per app:

## RAG-Retrieval subset (1-4, 8, 9)
Chunking, Hybrid Search, Reranking, Context Window, HNSW, Semantic Cache.
Applies to query-driven apps and the pipeline producers that own those
stages.

## LLM-Safety subset (5-7)
PII + toxicity, Grounding/self-correction, Zero-result handling.
Applies to every app that calls an LLM — pipeline or query.

## Per-app coverage

| App | Class | Retrieval subset | Safety subset |
|---|---|---|---|
| chatbot | query | all | all |
| job-strategist | query | 2,3,4,8,9 | all |
| ingestion | pipeline producer | 1,2,8 | 5 |
| resume-import | pipeline | n/a | 5,6,7 |
| article-pipeline | generation | 2 (consumes KB) | 5,6,7 |

Each per-app file lists only applicable items as checkboxes with
Status / Evidence / Gap from the 2026-05-16 audit. Shared remediation
is tracked by the two GitHub issues (PII scrubber, grounding verifier).
```

- [ ] **Step 2: Write `rag-checklist/chatbot.md`**

Content (verbatim):

```markdown
# Chatbot — RAG Checklist

## RAG-Retrieval subset
- [x] 1 Chunking — IMPLEMENTED — shared/src/ingestion/implementations/DefaultChunker.ts:49-78 overlap via stride — no gap
- [x] 2 Hybrid Search — IMPLEMENTED — shared/src/rds/implementations/RdsVectorStore.ts:256-318 RRF k=60 — no gap
- [ ] 3 Reranking — PARTIAL — shared/src/retrieval/implementations/BedrockReranker.ts:75-131 exists — Gap: chatbot Lambda never calls it
- [ ] 4 Context Window — MISSING — Gap: Bedrock Agent retrieval opaque, no top-3 enforcement
- [x] 8 HNSW — IMPLEMENTED — RdsVectorStore.ts:222-224 ef_search=40 — Gap: M/ef_construction undocumented
- [ ] 9 Semantic Cache — MISSING — Gap: no response cache (sub-project 3)

## LLM-Safety subset
- [ ] 5 PII + toxicity — PARTIAL — shared/src/security/output-sanitiser.ts:94-138 redacts infra IDs — Gap: no input PII scrub -> shared PiiScrubber (issue)
- [ ] 6 Grounding — PARTIAL — Bedrock Guardrail filters server-side — Gap: no app-level verify/log -> shared grounding verifier, mode=block (issue)
- [ ] 7 Zero-result — PARTIAL — instructed in persona — Gap: untested, not instrumented
```

- [ ] **Step 3: Write `rag-checklist/job-strategist.md`**

Content (verbatim):

```markdown
# Job-Strategist — RAG Checklist

## RAG-Retrieval subset
- [ ] 2 Hybrid Search — PARTIAL — src/agents/research-agent.ts:138 useHybrid=true — Gap: fusion unverified in this app
- [x] 3 Reranking — IMPLEMENTED — src/agents/research-agent.ts:177-219 rerank + cosine fallback — no gap
- [ ] 4 Context Window — PARTIAL — research-agent.ts:83 MAX_KB_PASSAGES=15 — Gap: checklist wants top-3
- [x] 8 HNSW — IMPLEMENTED — research-agent.ts:113-140 over-fetch via HNSW — Gap: M/ef_construction undocumented
- [ ] 9 Semantic Cache — MISSING — Gap: prompt cache only, no response cache (sub-project 3)

## Not applicable
- 1 Chunking — chunking is upstream (ingestion); this app reads pre-chunked rows

## LLM-Safety subset
- [x] 5 PII + toxicity — IMPLEMENTED — research-agent.ts:40-54 PII patterns + strategist-agent.ts:532 output sanitise — Gap: migrate to shared PiiScrubber for redaction parity (issue)
- [ ] 6 Grounding — PARTIAL — prompt truthfulness mandate only — Gap: no backward verify -> shared grounding verifier, mode=block (issue)
- [ ] 7 Zero-result — PARTIAL — research-agent.ts:149 returns [] — Gap: no explicit "insufficient data" fallback
```

- [ ] **Step 4: Write `rag-checklist/ingestion.md`**

Content (verbatim):

```markdown
# Ingestion — RAG Checklist (pipeline producer)

## RAG-Retrieval subset
- [x] 1 Chunking — IMPLEMENTED — shared/src/ingestion/implementations/MarkdownChunker.ts:73-81 overlapChars=200 — Gap: table/code-block edge cases untested
- [x] 2 Hybrid Search (index build) — IMPLEMENTED — RdsVectorStore.ts:256-318 tsvector + vector — no gap
- [ ] 8 HNSW — PARTIAL — query-side ef_search present — Gap: M/ef_construction not documented/tuned

## Not applicable
- 3,4,6,7,9 — ingestion stores chunks; retrieval/generation/grounding/cache live in consumer apps

## LLM-Safety subset
- [ ] 5 PII — MISSING — Gap: README/commit/manifest text -> Bedrock + vector store unscrubbed -> shared PiiScrubber before extract + persist (issue)
```

- [ ] **Step 5: Write `rag-checklist/resume-import.md`**

Content (verbatim):

```markdown
# Resume-Import-Processor — RAG Checklist (pipeline)

## Not applicable
- 1 (no overlap needed — semantic chunks), 2,3,4 (batch, not query-driven), 8 (write-heavy), 9 (Tavily cache already present)

## LLM-Safety subset
- [ ] 5 PII — MISSING (CRITICAL) — Gap: names/emails/employers flow raw to Bedrock/Tavily/DB/logs -> shared PiiScrubber before every sink (issue)
- [ ] 6 Grounding — PARTIAL — prompt rules in src/bedrock/gap-analysis.ts:128-139 — Gap: no post-gen verify of gap suggestions -> shared grounding verifier, mode=flag (issue)
- [ ] 7 Zero-result — PARTIAL — src/bedrock/enrich-role.ts:94-113 skips gracefully — Gap: no user-facing "limited research" notice on total Tavily failure
```

- [ ] **Step 6: Write `rag-checklist/article-pipeline.md`**

Content (verbatim):

```markdown
# Article-Pipeline — RAG Checklist (generation)

## RAG-Retrieval subset
- [ ] 2 Hybrid Search — PARTIAL — src/agents/research-agent.ts:190-247 vector-only KB/pgvector — Gap: no BM25 path
- [ ] 3 Reranking — MISSING — Gap: all 10 KB passages injected unranked
- [ ] 4 Context Window — PARTIAL — Gap: all passages passed to writer, no top-3
- [ ] 9 Semantic Cache — PARTIAL — prompt cache only (sub-project 3)

## Not applicable
- 1 (consumes pre-chunked KB), 8 (infra-layer)

## LLM-Safety subset
- [ ] 5 PII + toxicity — MISSING (CRITICAL) — Gap: no PII scrub on draft, no toxicity filter on output -> shared PiiScrubber (issue) + toxicity tracked separately
- [ ] 6 Grounding — PARTIAL — QA agent != grounding check — Gap: add shared grounding verifier post-QA, mode=flag (issue)
- [ ] 7 Zero-result — PARTIAL — research-agent.ts:191-193 degrades silently — Gap: no halt/instruction when KB empty
```

- [ ] **Step 7: Commit**

```
git add rag-checklist/
git commit -m "docs(rag): add per-app split checklist files"
```

---

## Task 11: Open the two GitHub issues

**Files:** create two temp body files under `/tmp`, remove after.

- [ ] **Step 1: Confirm gh auth**

Run: `gh auth status`
Expected: logged in. If not, stop and ask the user to run `! gh auth login`.

- [ ] **Step 2: Write the PII issue body to a file**

Create `/tmp/issue-pii.md` with this content:

```markdown
## Why
Audit (2026-05-16) found 4/5 apps leak PII (names, emails, employers) to the
LLM, the DB, and logs. Fix once in @bedrock/shared.

## Shipped in sub-project 1
- PiiScrubber + IPiiDetector + RegexPiiDetector (RAG_Shared_Safety_Design_Review.md section C)
- ComprehendPiiDetector stub (this issue covers its implementation)

## Sub-project 2 acceptance (per app: scrub before LLM call, before DB write, before log emission)
- [ ] chatbot — input PII scrub before Bedrock Agent invoke
- [ ] job-strategist — migrate existing regex to shared PiiScrubber (redaction parity)
- [ ] ingestion — scrub README/commit/manifest before extract + vector persist
- [ ] resume-import — scrub before Bedrock/Tavily/DB/logs (CRITICAL)
- [ ] article-pipeline — scrub draft input + generated output
- [ ] ComprehendPiiDetector implemented behind IPiiDetector

Spec: RAG_Shared_Safety_Design_Review.md
```

- [ ] **Step 3: Create the PII issue**

```
gh issue create --title "shared: PII scrubber module — wire into all 5 apps" --label shared --label security --body-file /tmp/issue-pii.md
```
Expected: prints the new issue URL.

- [ ] **Step 4: Write the grounding issue body to a file**

Create `/tmp/issue-grounding.md` with this content:

```markdown
## Why
Grounding is prompt-only everywhere; no backward verification of generated
answers against retrieved context (checklist section 6).

## Shipped in sub-project 1
- IGroundingVerifier + BedrockGroundingVerifier, block|flag mode, EMF metrics
  (RAG_Shared_Safety_Design_Review.md section D)

## Sub-project 2 acceptance
- [ ] chatbot — verify post-generation, mode=block
- [ ] job-strategist — verify strategist output, mode=block
- [ ] resume-import — verify gap-analysis suggestions, mode=flag
- [ ] article-pipeline — verify post-QA, mode=flag
- [ ] GroundingChecked/GroundingFailed dashboards in Grafana

Spec: RAG_Shared_Safety_Design_Review.md
```

- [ ] **Step 5: Create the grounding issue**

```
gh issue create --title "shared: grounding verifier module — wire into LLM apps" --label shared --label security --body-file /tmp/issue-grounding.md
```
Expected: prints the new issue URL.

- [ ] **Step 6: Clean up and list**

```
rm /tmp/issue-pii.md /tmp/issue-grounding.md
gh issue list --label shared --limit 5
```
Expected: both issues listed. Record their URLs for the PR description.

Note: if either `--label` does not exist, rerun the failing `gh issue create`
without the missing `--label` flag and add the label in the GitHub UI later.

---

## Task 12: Final verification + branch wrap

**Files:** none.

- [ ] **Step 1: Full shared test + typecheck**

Run (from `applications/shared`): `npx jest && npx tsc --noEmit`
Expected: all suites PASS, zero type errors.

- [ ] **Step 2: Confirm no app code changed (scope guard)**

Run: `git diff --name-only develop...HEAD`
Expected: only paths under `applications/shared/src/security/`,
`applications/shared/src/grounding/`, `applications/shared/src/index.ts`,
`rag-checklist/`, and the two root design/plan docs. Any other path = scope
violation; stop and report.

- [ ] **Step 3: Push branch**

```
git push -u origin feat/rag-shared-safety
```

- [ ] **Step 4: Report**

Summarise to the user: modules + tests green, docs added, two issues opened
(with URLs), scope guard verified, branch pushed. Offer to open a PR.

---

## Self-Review

**Spec coverage:** section A docs -> Task 10. section B issues -> Task 11.
section C PII module -> Tasks 1-5. section D grounding module -> Tasks 6-9.
Scope guards -> Task 12 step 2. Success criteria (tests/typecheck green,
barrel exports) -> Tasks 5, 9, 12. All spec sections covered.

**Placeholder scan:** No TBD/TODO; every code step has full code; every
command has expected output. Clean.

**Type consistency:** `IPiiDetector.detect`, `PiiSpan{start,end,type,value}`,
`PiiScrubber.scrub -> {redacted,spans,found}`, `IGroundingVerifier.verify ->
GroundingResult{status,reason,ungroundedClaims,answer}`,
`emitEmfMetric(namespace,dimensions,metrics,properties?)` — names consistent
across Tasks 1-9 and match the existing `emf.ts` signature.

**Note for executor:** Task 9 Step 2 inspects `applications/shared/src/index.ts`
to follow the existing re-export pattern; conditional instruction handles both
"security already exported" and "not yet" cases.
