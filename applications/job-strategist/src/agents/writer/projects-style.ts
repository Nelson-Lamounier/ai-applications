/**
 * @format
 * Composed-bullet narrative style guard -- deterministic, GENERIC pattern
 * checks for the projects lane's four-beat contract (WHAT I did -> the
 * CONCEPT in public JD vocabulary -> WHY it mattered -> the RESULT/VALUE;
 * see prompts/content/strategist/projects-agent.md and this run's driver,
 * docs/superpowers/specs/2026-07-16-projects-narrative-quality-design.md
 * Component 3).
 *
 * GENERALITY IS A HARD REQUIREMENT (production-ready for ANY user, ANY JD):
 * every pattern below is structural -- it matches a SHAPE (SNAKE_CASE casing,
 * `()` call syntax, a bare "N+"/"Nk+"/"Nm+" numeral), never a specific
 * identifier, repo name, or skill. There is no allowlist or blocklist of
 * known tokens anywhere in this module, and there must never be one -- a
 * blocklist only catches identifiers someone already thought of, and a
 * hardcoded list would silently stop generalising to the next user's
 * codebase. The run that motivated this guard (fe421faf) leaked an
 * environment-variable name, `(RETRIEVAL_PREFILTER)`, into a resume bullet --
 * the `internal_identifier` pattern below catches that SHAPE (an
 * ALL-CAPS/digits token with an underscore-joined segment), not that string.
 *
 * OUT OF SCOPE, DELIBERATELY: unintroduced-acronym detection (an ALL-CAPS
 * token of length 3-6 used without its concept spelled out nearby, e.g. a
 * bare "HNSW"). Distinguishing a genuinely UNEXPLAINED acronym from a
 * perfectly normal, already-public one ("AWS", "API", "SQL") requires
 * clause-level semantic judgement -- whether the concept was spelled out
 * "nearby" is not something a regex can decide without either false-flagging
 * every common acronym or missing the cases that matter. That rule stays
 * PERSONA-ONLY (the four-beat contract's second beat: introduce an acronym
 * with its concept on first use) -- enforced by the model's own instruction,
 * not this lint. Adding a heuristic for it here would trade a clean,
 * zero-false-positive structural guard for a noisy one; if evidence later
 * shows the persona rule alone is not enough, revisit with a proper
 * evaluated heuristic, not a quick regex bolt-on.
 */

export type StyleFindingKind = 'internal_identifier' | 'bare_plus_numeric' | 'code_call';

export interface StyleFinding {
  readonly kind: StyleFindingKind;
  readonly token: string;
}

/** SNAKE_CASE constants / env-var-shaped tokens -- an ALL-CAPS run with at
 *  least one underscore-joined segment (e.g. RETRIEVAL_PREFILTER,
 *  EMBEDDING_CACHE_TTL). Never matches a bare acronym ("AWS", "API") because
 *  those have no underscore segment to join. */
const INTERNAL_IDENTIFIER_RE = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g;

/** Bare "N+" / "Nk+" / "Nm+" numerals -- flags BOTH "100+" and "12k+"; the
 *  persona's replacement is an exact figure or "more than N". */
const BARE_PLUS_NUMERIC_RE = /\b\d+[km]?\+/gi;

/** Code-call syntax -- an identifier immediately followed by `()`
 *  (e.g. "sanitizeMdx()"). */
const CODE_CALL_RE = /\b[a-zA-Z_]\w*\(\)/g;

/** Every non-overlapping match of `re` in `text`, as `StyleFinding`s of `kind`. */
function findAll(text: string, re: RegExp, kind: StyleFindingKind): StyleFinding[] {
  return Array.from(text.matchAll(re), (m) => ({ kind, token: m[0] }));
}

/**
 * Deterministic, generic style findings for one composed bullet's text.
 * Curated (quote-only) bullets are never passed here for repair -- see
 * `projects-ats-flow.ts`'s `composedStyleFindings`/`curatedStyleFindings`,
 * which route composed findings into repair and curated findings into
 * advisory-only counters. Pure and total: never throws, empty input yields
 * an empty array.
 */
export function checkComposedBulletStyle(text: string): StyleFinding[] {
  return [
    ...findAll(text, INTERNAL_IDENTIFIER_RE, 'internal_identifier'),
    ...findAll(text, BARE_PLUS_NUMERIC_RE, 'bare_plus_numeric'),
    ...findAll(text, CODE_CALL_RE, 'code_call'),
  ];
}
