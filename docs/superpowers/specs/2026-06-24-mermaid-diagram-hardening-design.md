# Mermaid architecture-diagram hardening — design

**Date:** 2026-06-24
**Status:** approved (design)
**Repos:** ai-applications (deterministic normaliser at generation + prompt + tests) + tucaken-app (client-side normalise-on-render + graceful fallback).

## Problem

The case-study agent emits the project `architecture` as a Mermaid graph string
(`diagramSource`). The model frequently produces **invalid Mermaid**: node labels
contain a literal `\n` escape (two characters, backslash + `n`) for an intended
in-label line break, e.g. `App[admin-api BFF\nHono]`. Mermaid's lexer does not
interpret `\n` and rejects the unrecognised `\` — "Lexical error on line N.
Unrecognized text". Labels with other special characters (`Node.js`, `( )`, `/`,
`:`) are also fragile when unquoted.

Three pipeline gaps let it reach the screen:

1. **Generation** (`case-study-agent.ts`): the tool schema only requires
   `diagramSource` to be a non-empty string — it never checks the Mermaid parses.
2. **Persistence** (`project_architecture.diagram_source`): stored verbatim.
3. **Render** (`ArchitectureDiagram.tsx`): passes the raw string to
   `mermaid.render()`, which throws; the catch shows the lexer message in the UI.

Result: the user hand-fixes the diagram (and the broken UI) after every
generation. Confirmed in the live DB: `frontend-portfolio` and "AI Applications
Platform…" both store labels with literal `\n` (e.g. `App[tucaken-app\nTanStack
Start SSR]`).

## Decisions (locked)

1. **Full defense-in-depth:** deterministic normaliser at generation time (the
   guarantee) + graceful UI fallback (never show a lexer dump) + prompt
   hardening + tests.
2. **Deterministic normaliser**, not a real Mermaid parse (no jsdom in the
   headless job). The known LLM defects are fixable with deterministic string
   transforms; the UI fallback catches anything exotic.
3. **No DB backfill.** The two already-broken rows are left in place; the
   client-side normalise-on-render (below) makes them display correctly without
   touching the DB, and new generations are fixed at the source.

## The normaliser (the core unit)

A pure function `normaliseMermaidSource(source: string): string`, defined
**independently in each repo** (small, no cross-repo shared package available)
with its own tests. Same contract both sides:

1. **Literal escapes -> `<br/>`:** replace the two-character sequences `\n`,
   `\r\n`, `\r` (backslash + letter) with `<br/>`. Real newlines (the bytes that
   separate Mermaid statements) are a different character and are left untouched,
   so statement structure is preserved; only in-label literal escapes change.
2. **Quote special-char node labels:** for each Mermaid node-shape bracket —
   matched longest-first so compound shapes win: `[(` … `)]`, `([` … `])`,
   `{{` … `}}`, `[` … `]`, `(` … `)`, `{` … `}` — if the inner label text is not
   already wrapped in `"…"` and contains a character outside a safe set
   (anything other than `[A-Za-z0-9 _-]`, e.g. `.`/`(`/`)`/`/`/`:`/`<br/>`/`&`),
   wrap it in double quotes. Any literal `"` inside the captured text is first
   replaced with `&quot;` so the wrapping quotes stay balanced.
3. **Idempotent:** running it twice yields the same string (already-quoted
   labels and already-converted `<br/>` are left alone), so it is safe to apply
   at generation AND again on render.

It only ever runs when `diagramFormat === 'mermaid'`; stored SVG is untouched.

## Components

### ai-applications (generation side — the guarantee)

- **`normaliseMermaidSource`** — new pure function in
  `applications/shared/src/projects/` (sibling of `case-study-schema-repair.ts`),
  with a focused unit test using the two real broken samples from the live DB.
- **Apply it before persistence:** in the agent result path, after the
  architecture object is finalised (alongside the existing
  `coerceArchitectureString` / `clampOversizedFields` repairs) — normalise
  `architecture.diagramSource` when `diagramFormat === 'mermaid'`. Every newly
  generated/persisted diagram is therefore valid Mermaid.
- **Prompt hardening** (`case-study-agent.ts`, the `architecture` instruction):
  tell the model to use `<br/>` for in-label line breaks and to quote any label
  containing punctuation — `["admin-api BFF<br/>Hono"]`, never
  `[admin-api BFF\nHono]`. Reduces bad output (defense, not the guarantee).

### tucaken-app (render side — UI never breaks)

- **`normaliseMermaidSource`** — duplicate of the same pure function (its own
  unit test), in `src/features/projects/lib/`.
- **Normalise-on-render:** in `ArchitectureDiagram.tsx`, run the source through
  the normaliser before `mermaid.render()`. This fixes the display of the two
  existing broken DB rows (and any future slip) without a backfill.
- **Graceful fallback on parse failure:** if `mermaid.render()` still throws,
  do NOT show the raw lexer error. Instead render a clean fallback from the
  structured data the row already has — `project_architecture.nodes` + `edges`
  (a simple node/edge list) — or, if those are empty, a tidy "Diagram preview
  unavailable" panel with the existing **View source** toggle still available.
  The scary lexer string never reaches the user.

## Data flow

```text
case-study agent emits architecture.diagramSource (may be invalid Mermaid)
  -> schema repairs (coerceArchitectureString / clampOversizedFields)
  -> normaliseMermaidSource(diagramSource)         [ai-app: the guarantee]
  -> persist to project_architecture.diagram_source (now valid)
        |
        v  (render)
  ArchitectureDiagram: normaliseMermaidSource(source) -> mermaid.render()
     success -> SVG
     throw   -> fallback render from nodes/edges (or tidy message)  [UI never breaks]
```

## Error handling / safety

- The normaliser is pure + idempotent + total (never throws; a non-string or
  empty input returns unchanged). It only transforms `mermaid` sources.
- Generation-side normalisation is best-effort: if it somehow produced a worse
  string, the render-side normaliser + fallback still protect the UI.
- No DB writes beyond the existing persistence path; no migration; no backfill.
- `is_user_edited` diagrams are already protected by the persistence guard and
  are unaffected.

## Testing (per the repo's LLM-workflow principle 5)

- **ai-app normaliser unit test:** feed the two real broken samples (literal
  `\n` labels) + edge cases (already-quoted labels, compound shapes `[(...)]` /
  `{{...}}`, a label with a `"`, idempotency) and assert the output contains no
  literal `\n`, special-char labels are quoted, and re-running is a no-op.
- **ai-app persistence/agent test:** the persisted `diagramSource` is the
  normalised form when the model emits a literal-`\n` diagram.
- **tucaken normaliser unit test:** identical cases (the two functions must stay
  behaviourally identical; the tests document the shared contract).
- **tucaken `ArchitectureDiagram` test:** a source with literal `\n` renders
  (normalised) without error; a source that still fails to parse shows the
  nodes/edges fallback, not the lexer message.

## Out of scope

- Backfilling existing `project_architecture` rows (decided: leave them; the
  render-side normaliser displays them correctly).
- A real Mermaid parser / jsdom in the job (decided: deterministic only).
- Changing the case-study agent's overall generation logic, nodes/edges schema,
  or any non-architecture field.
- A shared cross-repo package for the normaliser (duplicated by design; kept in
  sync by identical tests).
