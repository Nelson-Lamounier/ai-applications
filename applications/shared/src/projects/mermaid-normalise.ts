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
