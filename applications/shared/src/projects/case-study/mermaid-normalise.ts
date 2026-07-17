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

// A quote OPENED by a shape token (`(["`, `[("`, `["`, ...) — the start of a
// quoted node label. Edge labels (` -- "HTTPS" --> `) are preceded by a space,
// so they never match.
const LABEL_OPEN = /(\(\[|\[\(|\[\[|\{\{|\(\(|\[|\(|\{|>)"/;

/**
 * Escape double quotes NESTED inside a quoted node label — one bad label
 * (`(["AWS Bedrock<br/>("Claude + Titan")"])`, observed live) makes Mermaid
 * fail the ENTIRE diagram. Per line: find the first shape-opened quote and the
 * last quote that closes into a shape; any quote strictly between them becomes
 * `&quot;`. Lines whose span carries an arrow (`-->`/`---`) are multi-node
 * edge lines where that span is not a single label — left untouched.
 */
function escapeNestedLabelQuotes(line: string): string {
  const m = LABEL_OPEN.exec(line);
  if (!m) return line;
  const start = m.index + m[0].length;
  let end = -1;
  for (let i = line.length - 1; i > start; i--) {
    if (line[i] === '"' && /[\])}]/.test(line[i + 1] ?? '')) { end = i; break; }
  }
  if (end <= start) return line;
  const inner = line.slice(start, end);
  if (!inner.includes('"') || inner.includes('-->') || inner.includes('---')) return line;
  return line.slice(0, start) + inner.replace(/"/g, '&quot;') + line.slice(end);
}

/**
 * Make an LLM-emitted Mermaid diagram parseable. Deterministic, pure, total and
 * idempotent. Three transforms:
 *   1. literal escape sequences (`\n`, `\r\n`, `\r` -- backslash + letter) become
 *      `<br/>`. REAL newlines (the bytes separating statements) are different
 *      characters and are left untouched.
 *   2. double quotes nested inside an already-quoted label are escaped to
 *      `&quot;` (see escapeNestedLabelQuotes).
 *   3. each node-shape label that is not already quoted and contains punctuation
 *      is wrapped in double quotes (inner `"` escaped to `&quot;`).
 * Labels are assumed not to contain raw bracket characters (the rare exception is
 * caught by the render-side fallback, not here).
 */
export function normaliseMermaidSource(source: string): string {
  if (typeof source !== 'string' || source.length === 0) return source;
  let out = source.replace(/\\r\\n|\\n|\\r/g, '<br/>');
  out = out.split('\n').map(escapeNestedLabelQuotes).join('\n');
  // Mask already-quoted spans so the wrap pass below can never rewrite their
  // interiors — a parenthetical INSIDE a quoted label would otherwise match
  // the round-node shape and get spuriously re-quoted.
  const spans: string[] = [];
  out = out.replace(/"[^"\n]*"/g, (quoted) => {
    spans.push(quoted);
    return `__QMASK${spans.length - 1}__`;
  });
  for (const [open, close] of SHAPES) {
    // Inner text excludes ALL bracket characters so compound shapes (already
    // handled earlier in the loop) are never re-matched or double-wrapped.
    const re = new RegExp(`${escapeRegExp(open)}([^[\\]{}()]*?)${escapeRegExp(close)}`, 'g');
    out = out.replace(re, (_m, inner: string) => `${open}${wrapIfNeeded(inner)}${close}`);
  }
  out = out.replace(/__QMASK(\d+)__/g, (_m, i: string) => spans[Number(i)]);
  // Post-pass: the wrap above may have quoted a label whose text carried its
  // own quoted word (`N[say "hi".now]` -> `N["say "hi".now"]`) — escape those
  // now-nested quotes the same way as model-emitted ones.
  return out.split('\n').map(escapeNestedLabelQuotes).join('\n');
}
