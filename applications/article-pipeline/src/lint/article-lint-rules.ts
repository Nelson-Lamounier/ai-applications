/**
 * article-lint-rules.ts
 *
 * Deterministic post-draft checks for the article pipeline QA stage.
 * These complement the stop-slop prose linter: everything here is a
 * mechanical check that should FAIL CI (severity "error") or annotate the
 * QA report (severity "warn") — no LLM judgement required.
 *
 * Usage:
 *   const findings = lintArticle(mdxSource, frontmatter);
 *   const errors = findings.filter(f => f.severity === "error");
 *
 * checkLinks() is async (network) and intended for the QA stage only,
 * gated behind an env flag so local runs stay offline.
 *
 * NOTE ON SEVERITIES (v1, record-only): findings are recorded to
 * pipeline_runs.metadata + surfaced in the admin review UI; nothing hard-blocks
 * a run yet. Two rules are known false-positive risks and are candidates to
 * demote to "warn" at promotion review if they prove noisy on real runs:
 *   - identifier-leak:account-id (bare 12-digit numbers)
 *   - cross-section-duplicate (distinctive 6-grams)
 * They are kept at their authored severity here; promotion is a one-line flip.
 */

export type Severity = 'error' | 'warn';

export interface Finding {
  rule: string;
  severity: Severity;
  message: string;
  /** 1-based line number where the finding starts, if known. */
  line?: number;
  excerpt?: string;
}

export interface Frontmatter {
  title: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

interface Section {
  heading: string;
  startLine: number;
  body: string;
}

/** Split MDX into H2 sections. Content before the first H2 is "preamble". */
export function splitSections(source: string): Section[] {
  const lines = source.split('\n');
  const sections: Section[] = [];
  let current: Section = { heading: 'preamble', startLine: 1, body: '' };
  lines.forEach((line, i) => {
    const m = /^##\s+(.+)$/.exec(line);
    if (m) {
      sections.push(current);
      current = { heading: m[1].trim(), startLine: i + 1, body: '' };
    } else {
      current.body += line + '\n';
    }
  });
  sections.push(current);
  return sections;
}

/** Strip code fences, inline code, MDX components, and frontmatter. */
export function proseOnly(source: string): string {
  return source
    .replace(/^---[\s\S]*?---/, '') // frontmatter
    .replace(/```[\s\S]*?```/g, '') // fenced code
    .replace(/<[A-Z][\s\S]*?\/>/g, '') // self-closing MDX components
    .replace(/<[A-Z]\w*[\s\S]*?<\/[A-Z]\w*>/g, '') // paired MDX components
    .replace(/`[^`]*`/g, ''); // inline code
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with',
  'is', 'are', 'was', 'it', 'that', 'this', 'at', 'by', 'as', 'be', 'not',
]);

function normalise(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Rule 1 — Title/body claim coverage ("Golden Path" bug)
// ---------------------------------------------------------------------------

/**
 * Every significant title term (non-stopword, length >= 4) must appear in
 * the body at least twice — once is a mention, twice is development.
 * Multi-word title phrases in quotes or Title Case are checked as phrases.
 */
export function checkTitleCoverage(
  source: string,
  fm: Frontmatter,
): Finding[] {
  const findings: Finding[] = [];
  const body = proseOnly(source).toLowerCase();
  const terms = normalise(fm.title).filter(
    (t) => !STOPWORDS.has(t) && t.length >= 4,
  );
  for (const term of terms) {
    const count = body.split(term).length - 1;
    if (count < 2) {
      findings.push({
        rule: 'title-coverage',
        severity: count === 0 ? 'error' : 'warn',
        message:
          `Title term "${term}" appears ${count}x in body. ` +
          `Every title concept must be developed in the body (>=2 uses) ` +
          `or removed from the title.`,
      });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Rule 2 — Cross-section near-duplicate phrases
// ---------------------------------------------------------------------------

/**
 * Detects distinctive word 6-grams that recur across DIFFERENT sections.
 * Catches "sync waves are a contract", triple-stated fixes, callout recap.
 */
export function checkCrossSectionDuplicates(source: string): Finding[] {
  const findings: Finding[] = [];
  const sections = splitSections(proseOnly(source));
  const N = 6;
  const seen = new Map<string, string>(); // ngram -> first section heading

  for (const s of sections) {
    const words = normalise(s.body);
    const reported = new Set<string>();
    for (let i = 0; i + N <= words.length; i++) {
      const gram = words.slice(i, i + N);
      // Skip grams that are mostly stopwords — not distinctive.
      if (gram.filter((w) => !STOPWORDS.has(w)).length < 3) continue;
      const key = gram.join(' ');
      const firstIn = seen.get(key);
      if (firstIn === undefined) {
        seen.set(key, s.heading);
      } else if (firstIn !== s.heading && !reported.has(key)) {
        reported.add(key);
        findings.push({
          rule: 'cross-section-duplicate',
          severity: 'error',
          message:
            `Phrase repeated across sections ("${firstIn}" and ` +
            `"${s.heading}"): "${key}". State once, reference elsewhere.`,
          line: s.startLine,
        });
      }
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Rule 3 — Slop constructions the base linter misses
// ---------------------------------------------------------------------------

const SLOP_PATTERNS: Array<{ name: string; re: RegExp; max: number }> = [
  {
    name: 'not-just-x-but-y',
    re: /\bnot (just|only|merely)\b[^.\n]{0,80}[-—;,][^.\n]{0,80}\b(it is|it's|but)\b/gi,
    max: 0,
  },
  {
    name: 'negation-pair',
    // "by design, not by accident" / "a contract, not a hint"
    re: /\b(\w+[^,.\n]{0,30}),\s+not\s+(a\s+|an\s+|by\s+)?\w+/gi,
    max: 1,
  },
  {
    name: 'staccato-triad',
    // "No tokens. No expiry. No CronJobs." — three consecutive <=5-word sentences
    re: /(?:^|\s)(?:[A-Z][^.!?\n]{0,28}[.!?]\s+){3,}/g,
    max: 1,
  },
];

export function checkSlopConstructions(source: string): Finding[] {
  const findings: Finding[] = [];
  const prose = proseOnly(source);
  for (const p of SLOP_PATTERNS) {
    const matches = [...prose.matchAll(p.re)];
    if (matches.length > p.max) {
      findings.push({
        rule: `slop:${p.name}`,
        severity: 'warn',
        message:
          `Construction "${p.name}" used ${matches.length}x ` +
          `(max ${p.max}). First: "${matches[0][0].trim().slice(0, 80)}"`,
      });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Rule 4 — Em-dash density
// ---------------------------------------------------------------------------

export function checkEmDashDensity(source: string): Finding[] {
  const prose = proseOnly(source);
  const paragraphs = prose
    .split(/\n\s*\n/)
    .filter((p) => p.trim().length > 80);
  if (paragraphs.length === 0) return [];
  const dashes = paragraphs.reduce(
    (n, p) => n + (p.match(/—|--/g)?.length ?? 0),
    0,
  );
  const perPara = dashes / paragraphs.length;
  if (perPara > 1.0) {
    return [
      {
        rule: 'em-dash-density',
        severity: 'warn',
        message:
          `Em-dash density ${perPara.toFixed(2)} per paragraph ` +
          `(threshold 1.0). Vary punctuation: commas, colons, ` +
          `parentheses, or restructure.`,
      },
    ];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Rule 5 — Dangling references (name-dropped, never explained)
// ---------------------------------------------------------------------------

/**
 * Heuristic: a "caveat"/"issue"/"trap"/"gotcha" noun-phrase mentioned in a
 * subordinate clause with no sentence developing it, OR an inline-code
 * technical term appearing exactly once in the entire article inside a
 * parenthetical. Flags for human review rather than hard-failing.
 */
export function checkDanglingReferences(source: string): Finding[] {
  const findings: Finding[] = [];
  const prose = proseOnly(source);

  // Pattern: "(with the ... caveat)" style parenthetical name-drops
  const nameDrops = [
    ...prose.matchAll(
      /\((?:with|note|see)?\s*the\s+[^)]{10,90}\b(caveat|issue|trap|gotcha|limitation|quirk)\b[^)]*\)/gi,
    ),
  ];
  for (const m of nameDrops) {
    findings.push({
      rule: 'dangling-reference',
      severity: 'warn',
      message:
        `Parenthetical name-drop with no development: ` +
        `"${m[0].slice(0, 90)}". Explain it in 2 sentences or delete it.`,
    });
  }

  // Inline-code terms that appear exactly once in the whole article
  const codeTerms = source.match(/`[^`\n]{6,60}`/g) ?? [];
  const counts = new Map<string, number>();
  for (const t of codeTerms) counts.set(t, (counts.get(t) ?? 0) + 1);
  // Only flag once-used terms that look like flags/settings (contain = or .)
  for (const [term, n] of counts) {
    if (n === 1 && /[=.]/.test(term) && !/^`https?:/.test(term)) {
      // Single mention of a setting is fine if a code block shows it; check.
      const bare = term.slice(1, -1);
      const inCodeBlock = new RegExp(
        '```[\\s\\S]*?' + bare.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
          '[\\s\\S]*?```',
      ).test(source);
      if (!inCodeBlock) {
        findings.push({
          rule: 'dangling-reference',
          severity: 'warn',
          message:
            `Technical term ${term} mentioned once and never shown in a ` +
            `code block. Develop it or cut it.`,
        });
      }
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Rule 6 — TOC generation ban
// ---------------------------------------------------------------------------

export function checkNoManualToc(source: string): Finding[] {
  const tocHeading = /^##\s+table of contents\s*$/im.test(source);
  const anchorList =
    (source.match(/^\s*-\s+\[[^\]]+\]\(#[a-z0-9-]+\)\s*$/gim)?.length ?? 0) >= 3;
  if (tocHeading || anchorList) {
    return [
      {
        rule: 'no-manual-toc',
        severity: 'error',
        message:
          'Manual Table of Contents detected. TOC is a rendering-layer ' +
          'concern; remove the section from the draft.',
      },
    ];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Rule 7 — Link quality (shallow links, count, liveness)
// ---------------------------------------------------------------------------

interface LinkInfo {
  url: string;
  line: number;
}

export function extractExternalLinks(source: string): LinkInfo[] {
  const links: LinkInfo[] = [];
  source.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)) {
      links.push({ url: m[1], line: i + 1 });
    }
  });
  return links;
}

/** Sync checks: shallow-link classification and per-article cap. */
export function checkLinkShape(source: string, maxLinks = 5): Finding[] {
  const findings: Finding[] = [];
  const links = extractExternalLinks(source);

  if (links.length > maxLinks) {
    findings.push({
      rule: 'link-count',
      severity: 'warn',
      message: `${links.length} external links (cap ${maxLinks}). Each must justify itself.`,
    });
  }

  for (const l of links) {
    const u = new URL(l.url);
    const pathDepth = u.pathname.split('/').filter(Boolean).length;
    // Homepage or single-segment path = shallow. Deep docs have >=2 segments.
    if (pathDepth < 2 && !u.hash) {
      findings.push({
        rule: 'shallow-link',
        severity: 'error',
        message:
          `Shallow link ${l.url} — link the exact doc page for the exact ` +
          `claim, or remove the link.`,
        line: l.line,
      });
    }
  }
  return findings;
}

/** Async liveness check for the QA stage. HEAD with GET fallback. */
export async function checkLinkLiveness(
  source: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Finding[]> {
  const findings: Finding[] = [];
  const links = extractExternalLinks(source);
  await Promise.all(
    links.map(async (l) => {
      try {
        let res = await fetchImpl(l.url, {
          method: 'HEAD',
          redirect: 'follow',
          signal: AbortSignal.timeout(8000),
        });
        if (res.status === 405 || res.status === 403) {
          res = await fetchImpl(l.url, {
            method: 'GET',
            redirect: 'follow',
            signal: AbortSignal.timeout(8000),
          });
        }
        if (!res.ok) {
          findings.push({
            rule: 'dead-link',
            severity: 'error',
            message: `Link ${l.url} returned ${res.status}.`,
            line: l.line,
          });
        } else if (new URL(res.url).hostname !== new URL(l.url).hostname) {
          findings.push({
            rule: 'redirected-link',
            severity: 'warn',
            message:
              `Link ${l.url} redirects cross-host to ${res.url} — ` +
              `likely a migrated/stale doc URL. Link the final location.`,
            line: l.line,
          });
        }
      } catch {
        findings.push({
          rule: 'dead-link',
          severity: 'error',
          message: `Link ${l.url} unreachable (timeout/DNS).`,
          line: l.line,
        });
      }
    }),
  );
  return findings;
}

// ---------------------------------------------------------------------------
// Rule 8 — Operational identifier leaks
// ---------------------------------------------------------------------------

/**
 * Flags identifiers that must be a deliberate publish decision, not a KB
 * default. Maintain the allowlist in the article's frontmatter:
 *   publishIdentifiers: ["k8s-eks-development"]
 */
export function checkIdentifierLeaks(
  source: string,
  allowlist: string[] = [],
): Finding[] {
  const findings: Finding[] = [];
  const patterns: Array<{ name: string; re: RegExp }> = [
    { name: 'ssm-path', re: /\/k8s\/[a-z0-9-]+\/[a-z0-9/_-]+/gi },
    { name: 'pod-identity-assoc-id', re: /\ba-[a-z0-9]{12,}\b/g },
    { name: 'arn', re: /\barn:aws:[a-z0-9-]+:[a-z0-9-]*:\d{12}:[^\s"'`]+/g },
    { name: 'account-id', re: /\b\d{12}\b/g },
    {
      name: 'kb-verification-metadata',
      re: /\bverified active \d{4}-\d{2}-\d{2}\b/gi,
    },
  ];
  for (const p of patterns) {
    for (const m of source.matchAll(p.re)) {
      const value = m[0];
      if (allowlist.some((a) => value.includes(a))) continue;
      findings.push({
        rule: `identifier-leak:${p.name}`,
        severity: 'error',
        message:
          `Operational identifier in prose: "${value}". Generalise it or ` +
          `add it to frontmatter publishIdentifiers to publish deliberately.`,
      });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Rule 9 — Enumerated generalisations (GroundednessVerifier pre-filter)
// ---------------------------------------------------------------------------

/**
 * Surfaces "X, Y, and Z all <verb> this <property>" claims so the
 * GroundednessVerifier can demand per-member evidence. This linter only
 * detects and routes; the verifier decides.
 */
export function checkEnumeratedGeneralisations(source: string): Finding[] {
  const findings: Finding[] = [];
  const prose = proseOnly(source);
  const re =
    /\b([A-Z][\w-]+(?:\s[\w-]+){0,3}),\s+([A-Z][\w-]+(?:\s[\w-]+){0,3}),?\s+and\s+([A-Z][\w-]+(?:\s[\w-]+){0,3})\s+(?:all|each|both)\s+\w+/g;
  for (const m of prose.matchAll(re)) {
    findings.push({
      rule: 'enumerated-generalisation',
      severity: 'warn',
      message:
        `Enumerated claim requires per-member KB evidence: ` +
        `"${m[0].slice(0, 110)}". Route to GroundednessVerifier with ` +
        `members [${m[1]}, ${m[2]}, ${m[3]}].`,
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Rule 10 — Heading JSX-expression / anchor IDs (render-fatal)
// ---------------------------------------------------------------------------

/**
 * A heading containing a raw `{` — most often an explicit id like
 * `## Title {#anchor}` — is valid Markdown but MDX v2 reads `{...}` as a JSX
 * expression and fails to compile ("Could not parse expression with acorn"),
 * which is a hard 500 on the whole rendered page. Heading ids are generated at
 * render (rehype-slug), so the annotation is redundant as well as fatal.
 *
 * Flagged as `error` so it is caught at review, not at publish. Code fences are
 * skipped (a `#` line inside a code block is not a heading).
 */
export function checkHeadingExpressions(source: string): Finding[] {
  const findings: Finding[] = [];
  let inFence = false;
  source.split('\n').forEach((line, i) => {
    if (line.trimStart().startsWith('```')) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    if (!/^#{1,6}[ \t]/.test(line) || !line.includes('{')) return;
    findings.push({
      rule: 'heading-jsx-expression',
      severity: 'error',
      message:
        `Heading contains a raw "{" which MDX parses as a JSX expression and ` +
        `fails to render (whole-page 500): "${line.trim().slice(0, 80)}". ` +
        `Remove the {#anchor}/{…} — heading ids are generated at render.`,
      line: i + 1,
    });
  });
  return findings;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export function lintArticle(source: string, fm: Frontmatter): Finding[] {
  const allowlist =
    (fm.publishIdentifiers as string[] | undefined) ?? [];
  return [
    ...checkTitleCoverage(source, fm),
    ...checkCrossSectionDuplicates(source),
    ...checkSlopConstructions(source),
    ...checkEmDashDensity(source),
    ...checkDanglingReferences(source),
    ...checkNoManualToc(source),
    ...checkLinkShape(source),
    ...checkIdentifierLeaks(source, allowlist),
    ...checkEnumeratedGeneralisations(source),
    ...checkHeadingExpressions(source),
  ];
}
