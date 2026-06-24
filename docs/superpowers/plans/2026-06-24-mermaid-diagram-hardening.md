# Mermaid architecture-diagram hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Guarantee every generated project architecture diagram is valid Mermaid (deterministic normaliser at persist time) and the Projects UI never shows a Mermaid lexer error (client-side normalise-on-render + nodes/edges fallback).

**Architecture:** A pure, idempotent `normaliseMermaidSource(source)` — replaces literal `\n`/`\r` escapes with `<br/>` and quotes node labels containing punctuation. It is duplicated in both repos (no cross-repo shared package) with identical tests. ai-applications applies it in the persistence choke point (`upsertArchitecture`); tucaken-app applies it before `mermaid.render()` and falls back to a node/edge list if rendering still throws.

**Tech Stack:** ai-applications `applications/shared` (TS, jest); tucaken-app frontend (React 19, vitest). Cross-repo.

## Global Constraints

- English (UK) in comments/copy; NO non-ASCII characters in source (ASCII only — no em-dashes/arrows/box-drawing).
- ESLint clean on changed files; no `Co-Authored-By: Claude` trailer; `git commit --no-verify`.
- TDD: failing test first. ai-app: `cd applications/shared && npx jest <path>`; tucaken: `npx vitest run <path>` (frontend), `npx tsc --noEmit`. ESM/NodeNext (`.js` import extensions in ai-app + tucaken server/admin; frontend uses `@/` aliases).
- The two repos' `normaliseMermaidSource` MUST be behaviourally identical — the same test cases run in both. If you change the contract in one, change both.
- The normaliser is **pure, total, idempotent**: a non-string or empty input returns unchanged; running it twice equals running it once; it only transforms text (never throws).
- Branches: ai-applications work on `fix/mermaid-diagram-hardening` (spec already committed there, off `develop`). tucaken-app work in an **isolated git worktree off `origin/main`** on branch `fix/mermaid-diagram-render` — do NOT touch the user's active `feat/auth-redesign` checkout; do NOT run `git checkout`/`reset` in the main tucaken-app working tree.
- No DB migration, no backfill. `diagram_format === 'svg'` sources are never transformed.

## File Structure

**ai-applications** (branch `fix/mermaid-diagram-hardening`)
- `applications/shared/src/projects/mermaid-normalise.ts` — the pure normaliser.
- `applications/shared/src/projects/mermaid-normalise.test.ts` — its unit test.
- `applications/shared/src/projects/case-study-persistence.ts` — call the normaliser in `upsertArchitecture`.
- `applications/shared/src/projects/case-study-agent.ts` — prompt hardening (the `architecture` instruction).

**tucaken-app** (worktree, branch `fix/mermaid-diagram-render`)
- `src/features/projects/lib/mermaid-normalise.ts` — identical pure normaliser.
- `src/__tests__/features/projects/mermaid-normalise.test.ts` — identical unit test.
- `src/features/projects/components/ArchitectureDiagram.tsx` — normalise-on-render + nodes/edges fallback.
- `src/__tests__/features/projects/ArchitectureDiagram.test.tsx` — extend with normalise + fallback cases.

---

### Task 1: `normaliseMermaidSource` (ai-applications)

**Files:**
- Create: `applications/shared/src/projects/mermaid-normalise.ts`
- Test: `applications/shared/src/projects/mermaid-normalise.test.ts`

**Interfaces:**
- Produces: `export function normaliseMermaidSource(source: string): string` — pure, total, idempotent.

- [ ] **Step 1: Write the failing test**

Create `applications/shared/src/projects/mermaid-normalise.test.ts`:

```typescript
/** @format */
import { describe, it, expect } from '@jest/globals';
import { normaliseMermaidSource } from './mermaid-normalise.js';

describe('normaliseMermaidSource', () => {
  it('replaces literal \\n inside a label with <br/> and quotes it', () => {
    const out = normaliseMermaidSource('graph LR\n  App[tucaken-app\\nTanStack Start SSR]');
    expect(out).not.toMatch(/\\n/);          // no literal backslash-n remains
    expect(out).toContain('["tucaken-app<br/>TanStack Start SSR"]');
  });

  it('quotes hexagon + cylinder + stadium labels with punctuation', () => {
    expect(normaliseMermaidSource('A{{AWS Bedrock\\nSonnet / Haiku}}'))
      .toContain('{{"AWS Bedrock<br/>Sonnet / Haiku"}}');
    expect(normaliseMermaidSource('B[(RDS PostgreSQL\\n+ pgvector)]'))
      .toContain('[("RDS PostgreSQL<br/>+ pgvector")]');
    // A safe stadium label (only letters/space/hyphen) is left unquoted.
    expect(normaliseMermaidSource('U([Job-seeker])')).toContain('([Job-seeker])');
  });

  it('leaves real newlines (statement separators) intact', () => {
    const out = normaliseMermaidSource('graph LR\n  A-->B\n  B-->C');
    expect(out.split('\n')).toHaveLength(3);
  });

  it('escapes a literal double-quote inside a wrapped label', () => {
    expect(normaliseMermaidSource('N[say "hi".now]')).toContain('["say &quot;hi&quot;.now"]');
  });

  it('is idempotent', () => {
    const once = normaliseMermaidSource('graph LR\n  App[admin-api BFF\\nHono]');
    expect(normaliseMermaidSource(once)).toBe(once);
  });

  it('is total: empty / non-string returns unchanged', () => {
    expect(normaliseMermaidSource('')).toBe('');
    expect(normaliseMermaidSource(undefined as unknown as string)).toBe(undefined);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `cd applications/shared && npx jest src/projects/mermaid-normalise.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `mermaid-normalise.ts`**

Create `applications/shared/src/projects/mermaid-normalise.ts`:

```typescript
/** @format */

// A label is "safe" unquoted only if it is purely alphanumerics, spaces,
// underscores and hyphens. Anything else (., (, ), /, :, <br/>, &, ...) must be
// quoted so Mermaid's lexer does not choke.
const SAFE_LABEL = /^[A-Za-z0-9 _-]*$/;

// Mermaid node-shape bracket pairs, COMPOUND/LONGEST FIRST so `[(`...`)]` and
// `([`...`])` are matched before the bare `[`...`]` / `(`...`)` shapes.
const SHAPES: ReadonlyArray<readonly [open: string, close: string]> = [
  ['[(', ')]'],   // cylinder (datastore)
  ['([', '])'],   // stadium
  ['[[', ']]'],   // subroutine
  ['{{', '}}'],   // hexagon
  ['((', '))'],   // circle
  ['[', ']'],     // rectangle (service)
  ['(', ')'],     // round
  ['{', '}'],     // rhombus
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function wrapIfNeeded(inner: string): string {
  // Already quoted, or safe -> leave as-is (keeps the function idempotent).
  if (inner.startsWith('"') && inner.endsWith('"')) return inner;
  if (SAFE_LABEL.test(inner)) return inner;
  return `"${inner.replace(/"/g, '&quot;')}"`;
}

/**
 * Make an LLM-emitted Mermaid diagram parseable. Deterministic, pure, total and
 * idempotent. Two transforms:
 *   1. literal escape sequences (`\n`, `\r\n`, `\r` -- backslash + letter) become
 *      `<br/>`. REAL newlines (the bytes separating statements) are different
 *      characters and are left untouched.
 *   2. each node-shape label that is not already quoted and contains punctuation
 *      is wrapped in double quotes (inner `"` escaped to `&quot;`).
 * Labels are assumed not to contain raw bracket characters (the rare exception is
 * caught by the render-side fallback, not here).
 */
export function normaliseMermaidSource(source: string): string {
  if (typeof source !== 'string' || source.length === 0) return source;
  let out = source.replace(/\\r\\n|\\n|\\r/g, '<br/>');
  for (const [open, close] of SHAPES) {
    // Inner text excludes ALL bracket characters so compound shapes (already
    // handled earlier in the loop) are never re-matched or double-wrapped.
    const re = new RegExp(`${escapeRegExp(open)}([^[\\]{}()]*?)${escapeRegExp(close)}`, 'g');
    out = out.replace(re, (_m, inner: string) => `${open}${wrapIfNeeded(inner)}${close}`);
  }
  return out;
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `cd applications/shared && npx jest src/projects/mermaid-normalise.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Typecheck, lint, commit**

Run: `cd applications/shared && npx tsc --noEmit && npx eslint src/projects/mermaid-normalise.ts src/projects/mermaid-normalise.test.ts`
Expected: clean.

```bash
git add applications/shared/src/projects/mermaid-normalise.ts applications/shared/src/projects/mermaid-normalise.test.ts
git commit --no-verify -m "feat(projects): deterministic Mermaid source normaliser (literal-\\n + label quoting)"
```

---

### Task 2: Apply normaliser at persistence + harden the prompt (ai-applications)

**Files:**
- Modify: `applications/shared/src/projects/case-study-persistence.ts` (`upsertArchitecture`)
- Modify: `applications/shared/src/projects/case-study-agent.ts` (the `architecture` prompt instruction)
- Test: `applications/shared/src/projects/case-study-persistence.test.ts` (add a case)

**Interfaces:**
- Consumes: `normaliseMermaidSource` from `./mermaid-normalise.js` (Task 1).

- [ ] **Step 1: Write the failing test**

In `applications/shared/src/projects/case-study-persistence.test.ts`, add a case asserting the persisted `diagram_source` is normalised. Match the file's existing capture-the-SQL-params test style (it already inspects `UPDATE projects`/architecture queries). Add inside the architecture describe (mirror the existing fixture builder):

```typescript
it('normalises a literal-\\n Mermaid diagram before persisting', async () => {
  const calls: { sql: string; params: readonly unknown[] }[] = [];
  const client = { query: async (sql: string, params: readonly unknown[] = []) => {
    calls.push({ sql, params }); return { rows: [], rowCount: 1 };
  } } as unknown as import('pg').PoolClient;
  // Build a minimal PersistCaseStudyInput whose architecture has a literal \n
  // label and diagramFormat 'mermaid' (reuse this file's existing input factory;
  // only the architecture.diagramSource matters here).
  const input = makePersistInput({
    architecture: { diagramFormat: 'mermaid', diagramSource: 'graph LR\n  App[admin-api BFF\\nHono]', nodes: [], edges: [] },
  });
  await upsertArchitecture(client, input);
  const insert = calls.find((c) => /INSERT INTO project_architecture/i.test(c.sql))!;
  const sourceParam = insert.params[3] as string; // diagram_source is $4
  expect(sourceParam).not.toMatch(/\\n/);
  expect(sourceParam).toContain('["admin-api BFF<br/>Hono"]');
});
```

If the file has no exported `makePersistInput`/`upsertArchitecture` accessor, export `upsertArchitecture` (it is currently a module-private `async function`; add `export`) and build the input inline from the file's existing fixture shape.

- [ ] **Step 2: Run the test, verify it fails**

Run: `cd applications/shared && npx jest src/projects/case-study-persistence.test.ts -t "normalises a literal"`
Expected: FAIL — `diagram_source` still contains the literal `\n`.

- [ ] **Step 3: Apply the normaliser in `upsertArchitecture`**

In `case-study-persistence.ts`, add the import near the other project imports:

```typescript
import { normaliseMermaidSource } from './mermaid-normalise.js';
```

In `upsertArchitecture`, compute a normalised source and use it in the INSERT params (only for mermaid; SVG untouched). Replace the `a.diagramFormat, a.diagramSource,` params line:

```typescript
        const diagramSource = a.diagramFormat === 'mermaid'
            ? normaliseMermaidSource(a.diagramSource)
            : a.diagramSource;
```

and change the params array entry from `a.diagramFormat, a.diagramSource,` to `a.diagramFormat, diagramSource,`. (If `upsertArchitecture` was module-private, add `export` so the test can call it.)

- [ ] **Step 4: Harden the agent prompt**

In `case-study-agent.ts`, replace the `architecture` instruction (item 9, around line 130):

```
  9. `architecture` is a Mermaid graph (graph LR or graph TD).
     Rectangles for services, cylinders for datastores, clouds for
     external services. Keep it readable in 5 seconds. For a line break
     inside a node label use `<br/>` and WRAP THE WHOLE LABEL IN DOUBLE
     QUOTES, never a literal "\n". Quote any label containing punctuation,
     e.g. `App["admin-api BFF<br/>Hono"]` -- never `App[admin-api BFF\nHono]`.
```

(Keep it inside the existing template literal; escape backslashes/backticks as the surrounding string requires.)

- [ ] **Step 5: Run the tests, verify they pass**

Run: `cd applications/shared && npx jest src/projects/case-study-persistence.test.ts && npx tsc --noEmit && npx eslint src/projects/case-study-persistence.ts src/projects/case-study-agent.ts`
Expected: green; lint clean.

- [ ] **Step 6: Commit**

```bash
git add applications/shared/src/projects/case-study-persistence.ts applications/shared/src/projects/case-study-agent.ts applications/shared/src/projects/case-study-persistence.test.ts
git commit --no-verify -m "fix(projects): normalise Mermaid diagram at persist + prompt for <br/> labels"
```

---

### Task 3: `normaliseMermaidSource` (tucaken-app, identical)

**Files:**
- Create: `src/features/projects/lib/mermaid-normalise.ts`
- Test: `src/__tests__/features/projects/mermaid-normalise.test.ts`

**Interfaces:**
- Produces: `export function normaliseMermaidSource(source: string): string` — byte-for-byte the same logic as Task 1 (no `/** @format */` banner needed if the repo doesn't use it; match the repo's file style).

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/features/projects/mermaid-normalise.test.ts` — the SAME cases as Task 1, vitest flavour:

```typescript
import { describe, it, expect } from 'vitest'
import { normaliseMermaidSource } from '@/features/projects/lib/mermaid-normalise'

describe('normaliseMermaidSource', () => {
  it('replaces literal \\n inside a label with <br/> and quotes it', () => {
    const out = normaliseMermaidSource('graph LR\n  App[tucaken-app\\nTanStack Start SSR]')
    expect(out).not.toMatch(/\\n/)
    expect(out).toContain('["tucaken-app<br/>TanStack Start SSR"]')
  })
  it('quotes hexagon + cylinder labels, leaves safe stadium labels', () => {
    expect(normaliseMermaidSource('A{{AWS Bedrock\\nSonnet / Haiku}}')).toContain('{{"AWS Bedrock<br/>Sonnet / Haiku"}}')
    expect(normaliseMermaidSource('B[(RDS PostgreSQL\\n+ pgvector)]')).toContain('[("RDS PostgreSQL<br/>+ pgvector")]')
    expect(normaliseMermaidSource('U([Job-seeker])')).toContain('([Job-seeker])')
  })
  it('leaves real newlines intact', () => {
    expect(normaliseMermaidSource('graph LR\n  A-->B\n  B-->C').split('\n')).toHaveLength(3)
  })
  it('escapes a literal double-quote inside a wrapped label', () => {
    expect(normaliseMermaidSource('N[say "hi".now]')).toContain('["say &quot;hi&quot;.now"]')
  })
  it('is idempotent', () => {
    const once = normaliseMermaidSource('graph LR\n  App[admin-api BFF\\nHono]')
    expect(normaliseMermaidSource(once)).toBe(once)
  })
  it('is total: empty / non-string returns unchanged', () => {
    expect(normaliseMermaidSource('')).toBe('')
    expect(normaliseMermaidSource(undefined as unknown as string)).toBe(undefined)
  })
})
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run src/__tests__/features/projects/mermaid-normalise.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/features/projects/lib/mermaid-normalise.ts`**

Copy the Task 1 implementation verbatim (drop the `/** @format */` banner only if the repo's other `lib/` files don't use one; otherwise keep). The body — `SAFE_LABEL`, `SHAPES`, `escapeRegExp`, `wrapIfNeeded`, `normaliseMermaidSource` — is identical to Task 1.

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run src/__tests__/features/projects/mermaid-normalise.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Typecheck, lint, commit**

Run: `npx tsc --noEmit && npx eslint src/features/projects/lib/mermaid-normalise.ts src/__tests__/features/projects/mermaid-normalise.test.ts`
Expected: clean.

```bash
git add src/features/projects/lib/mermaid-normalise.ts src/__tests__/features/projects/mermaid-normalise.test.ts
git commit --no-verify -m "feat(projects): client Mermaid normaliser (mirrors the generation-side normaliser)"
```

---

### Task 4: Normalise-on-render + nodes/edges fallback (tucaken-app)

**Files:**
- Modify: `src/features/projects/components/ArchitectureDiagram.tsx`
- Test: `src/__tests__/features/projects/ArchitectureDiagram.test.tsx`

**Interfaces:**
- Consumes: `normaliseMermaidSource` (Task 3). The component already receives `format` + `source`; ADD optional structured fallback data `nodes`/`edges`.

**Nodes/edges shape** (from the case-study schema): `nodes: Array<{ id: string; label: string; kind: string }>`, `edges: Array<{ from: string; to: string; label?: string }>`. The stored columns are untyped JSON, so READ THEM DEFENSIVELY.

- [ ] **Step 1: Write the failing test**

In `src/__tests__/features/projects/ArchitectureDiagram.test.tsx`, add two cases. The existing tests mock `mermaid`; follow that pattern.

```typescript
// (a) a literal-\n source renders without surfacing a lexer error: assert the
// string passed to mermaid.render() has been normalised (no '\\n', contains <br/>).
it('normalises the source before calling mermaid.render', async () => {
  const renderSpy = vi.fn(async () => ({ svg: '<svg/>' }))
  vi.doMock('mermaid', () => ({ default: { initialize: vi.fn(), render: renderSpy } }))
  // render the component with source 'graph LR\n A[x\\ny]' and await the effect...
  // assert renderSpy was called with a string matching /<br\/>/ and not /\\n/.
})

// (b) when mermaid.render throws, the nodes/edges fallback is shown (a node label
// from `nodes`) and NOT the raw error text.
it('falls back to the node/edge list when mermaid.render throws', async () => {
  const renderSpy = vi.fn(async () => { throw new Error('Lexical error on line 8') })
  vi.doMock('mermaid', () => ({ default: { initialize: vi.fn(), render: renderSpy } }))
  // render with a bad source + nodes=[{id:'a',label:'AdminAPI',kind:'service'}],
  // edges=[{from:'a',to:'b'}]; assert the DOM shows 'AdminAPI' and NOT 'Lexical error'.
})
```

Fill the render/await bodies using the existing test's render + `waitFor` helpers (match how the current `ArchitectureDiagram.test.tsx` drives the async effect).

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run src/__tests__/features/projects/ArchitectureDiagram.test.tsx`
Expected: FAIL — source not normalised / raw error shown instead of fallback.

- [ ] **Step 3: Normalise on render + add the fallback**

In `ArchitectureDiagram.tsx`:

1. Import the normaliser + widen props:

```typescript
import { normaliseMermaidSource } from '../lib/mermaid-normalise'

type ArchNode = { id: string; label: string; kind?: string }
type ArchEdge = { from: string; to: string; label?: string }

export interface ArchitectureDiagramProps {
  readonly format: 'mermaid' | 'svg'
  readonly source: string
  readonly nodes?: unknown
  readonly edges?: unknown
}
```

2. In the mermaid branch of the effect, normalise before rendering:

```typescript
        const safeSource = normaliseMermaidSource(source)
        const { svg: rendered } = await mermaid.render(`arch-${reactId}`, safeSource)
```

3. Add a defensive reader + a fallback render. Above the component, add:

```typescript
function readNodes(raw: unknown): ArchNode[] {
  return Array.isArray(raw)
    ? raw.filter((n): n is ArchNode => !!n && typeof (n as ArchNode).label === 'string')
    : []
}
function readEdges(raw: unknown): ArchEdge[] {
  return Array.isArray(raw)
    ? raw.filter((e): e is ArchEdge => !!e && typeof (e as ArchEdge).from === 'string' && typeof (e as ArchEdge).to === 'string')
    : []
}
```

4. Replace the error branch in the returned JSX. Find:

```typescript
      {!showSource && error && (
        <p className="rounded-md bg-rose-400/5 px-4 py-6 text-center text-xs text-rose-300 inset-ring inset-ring-rose-400/30">
          {error}
        </p>
      )}
```

Replace with a graceful fallback (node/edge list when available, tidy message otherwise — NEVER the raw `error`):

```typescript
      {!showSource && error && (() => {
        const fbNodes = readNodes(nodes)
        const fbEdges = readEdges(edges)
        if (fbNodes.length === 0) {
          return (
            <p className="rounded-md bg-white/2 px-4 py-6 text-center text-xs text-zinc-400 inset-ring inset-ring-white/10">
              Diagram preview unavailable. Use <span className="font-medium text-zinc-300">View source</span> to see the raw definition.
            </p>
          )
        }
        const byId = new Map(fbNodes.map((n) => [n.id, n.label]))
        return (
          <div className="rounded-md bg-white/2 p-4 inset-ring inset-ring-white/10">
            <p className="mb-3 text-xs text-zinc-400">Diagram preview unavailable; showing the component map.</p>
            <ul className="flex flex-wrap gap-2">
              {fbNodes.map((n) => (
                <li key={n.id} className="rounded-md bg-teal-400/10 px-2 py-1 text-xs text-teal-200 inset-ring inset-ring-teal-400/20">{n.label}</li>
              ))}
            </ul>
            {fbEdges.length > 0 && (
              <ul className="mt-3 space-y-1 font-mono text-[11px] text-zinc-400">
                {fbEdges.map((e, i) => (
                  <li key={i}>{byId.get(e.from) ?? e.from} &rarr; {byId.get(e.to) ?? e.to}{e.label ? ` (${e.label})` : ''}</li>
                ))}
              </ul>
            )}
          </div>
        )
      })()}
```

5. Pass `nodes`/`edges` through from the caller. In `src/features/projects/components/detail/Architecture.tsx`, the `<ArchitectureDiagram>` call becomes:

```typescript
        <ArchitectureDiagram
          format={architecture.diagram_format}
          source={architecture.diagram_source}
          nodes={architecture.nodes}
          edges={architecture.edges}
        />
```

- [ ] **Step 4: Run the tests, verify they pass**

Run: `npx vitest run src/__tests__/features/projects/ArchitectureDiagram.test.tsx && npx tsc --noEmit && npx eslint src/features/projects/components/ArchitectureDiagram.tsx src/features/projects/components/detail/Architecture.tsx`
Expected: green; lint clean. Also run the existing projects suite (`npx vitest run src/__tests__/features/projects`) to confirm no regression.

- [ ] **Step 5: Commit**

```bash
git add src/features/projects/components/ArchitectureDiagram.tsx src/features/projects/components/detail/Architecture.tsx src/__tests__/features/projects/ArchitectureDiagram.test.tsx
git commit --no-verify -m "fix(projects): normalise Mermaid on render + node/edge fallback (no lexer errors in UI)"
```

---

## Self-Review

- **Spec coverage:** normaliser unit (Tasks 1, 3) ✓; generation-side guarantee at persist choke point + prompt hardening (Task 2) ✓; client normalise-on-render (Task 4 step 3.2) ✓; graceful nodes/edges fallback, never a lexer dump (Task 4 step 3.4) ✓; pure/total/idempotent contract tested both sides ✓; no migration/backfill ✓; SVG untouched (Task 2 step 3 guards `=== 'mermaid'`; Task 4 only normalises the mermaid branch) ✓; existing two broken rows display via render-side normaliser (Task 4) ✓.
- **Cross-repo identical normaliser:** Tasks 1 and 3 ship the same `SAFE_LABEL`/`SHAPES`/`escapeRegExp`/`wrapIfNeeded`/`normaliseMermaidSource` and the same six test cases. Keep them in lockstep.
- **Type consistency:** `normaliseMermaidSource(source: string): string` identical in both repos; `ArchNode`/`ArchEdge` (Task 4) match the case-study schema (`{id,label,kind}` / `{from,to,label?}`); `upsertArchitecture` exported for its test (Task 2).
- **Placeholder scan:** Task 4 step 1 leaves the render/await test bodies as prose-guided (they must mirror the existing `ArchitectureDiagram.test.tsx` async-render harness, which the implementer reads in-repo) — this is the one spot where the exact harness lines live in the existing test file, not the plan. Everything else is complete code.
- **Live verification (after merge + deploy):** open `frontend-portfolio` and the platform project — the architecture renders (no lexer error) via the render-side normaliser; generate a new project and confirm the persisted `diagram_source` has `<br/>` quoted labels and renders cleanly.
