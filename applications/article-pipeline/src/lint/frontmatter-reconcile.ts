/**
 * @format
 * frontmatter-reconcile.ts
 *
 * Deterministic post-Writer normalisation of the MDX article body. The Writer
 * (an LLM) authors the frontmatter freely, so its `slug`, `publishDate` and
 * `readingTime` drift from the canonical DB row: the served URL routes on the
 * DB `slug` (env.slug), the publish date is owned by admin-api, and the reading
 * time is a guess. This module overwrites those three fields with computed /
 * canonical values so the persisted frontmatter can never contradict the row.
 *
 * It also strips em-dash connectors from prose (the blog persona bans them; the
 * structural linter only *detects* them). All transforms are pure, reversible,
 * and operate only on prose — fenced code, inline code and MDX components are
 * left byte-for-byte intact.
 */
import { proseOnly } from './article-lint-rules.js';

/** Canonical values that win over whatever the Writer put in the frontmatter. */
export interface CanonicalFrontmatter {
  /** DB `slug` (env.slug) — the value the portfolio URL routes on. */
  readonly slug: string;
  /** ISO date (YYYY-MM-DD) stamped at generation time. */
  readonly publishDate: string;
  /** Reading time in whole minutes, computed from the prose. */
  readonly readingTime: number;
}

const WORDS_PER_MINUTE = 200;

/**
 * Whole-minute reading time from the article's prose word count (~200 wpm).
 * Code, MDX components and frontmatter are excluded via {@link proseOnly} so a
 * code-heavy article is not over-counted. Always at least 1.
 */
export function computeReadingTime(content: string, wordsPerMinute = WORDS_PER_MINUTE): number {
  const words = proseOnly(content).split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.ceil(words / wordsPerMinute));
}

/** Split a document into a leading YAML frontmatter block and the remaining body. */
function splitFrontmatter(content: string): { block: string | null; body: string } {
  const match = /^(---\n[\s\S]*?\n---)(\n[\s\S]*)?$/.exec(content);
  if (!match) return { block: null, body: content };
  return { block: match[1], body: match[2] ?? '' };
}

/** Replace `key: ...` inside the frontmatter block, or append it if absent. */
function setKey(block: string, key: string, rendered: string): string {
  const line = new RegExp(`^${key}:.*$`, 'm');
  if (line.test(block)) {
    return block.replace(line, rendered);
  }
  // Insert before the closing '---' so the block stays well-formed.
  return block.replace(/\n---$/, `\n${rendered}\n---`);
}

/**
 * Overwrite `slug`, `publishDate` and `readingTime` in the article's frontmatter
 * with canonical values. Every other field (title, description, tags, author,
 * category) is preserved. A document with no frontmatter block is returned
 * unchanged (the persist layer rejects those separately).
 */
export function reconcileFrontmatter(content: string, canonical: CanonicalFrontmatter): string {
  const { block, body } = splitFrontmatter(content);
  if (block === null) return content;
  let next = block;
  next = setKey(next, 'slug', `slug: "${canonical.slug}"`);
  next = setKey(next, 'publishDate', `publishDate: "${canonical.publishDate}"`);
  next = setKey(next, 'readingTime', `readingTime: ${canonical.readingTime}`);
  return next + body;
}

/**
 * Segment matcher for regions that must NOT be touched: fenced code blocks,
 * inline code spans, and MDX components (self-closing and paired). The gaps
 * between these matches are prose and are safe to transform.
 */
const PROTECTED = /```[\s\S]*?```|`[^`]*`|<[A-Z][\w]*[\s\S]*?<\/[A-Z][\w]*>|<[A-Z][\s\S]*?\/>/g;

/** Replace spaced em-dash / double-hyphen connectors in a prose fragment with a comma. */
function commaForDashes(prose: string): { text: string; count: number } {
  let count = 0;
  const text = prose.replace(/ (?:—|--) /g, () => {
    count++;
    return ', ';
  });
  return { text, count };
}

/**
 * Strip em-dash connectors from prose, leaving code and components intact.
 * Only the spaced connector forms (` — ` and ` -- `) are rewritten to a comma;
 * glued em-dashes, hyphenated words and numeric ranges are left alone. Returns
 * the rewritten content and the number of substitutions made (for audit).
 */
export function stripProseEmDashes(content: string): { content: string; replaced: number } {
  let replaced = 0;
  let lastIndex = 0;
  let out = '';
  for (const match of content.matchAll(PROTECTED)) {
    const gap = content.slice(lastIndex, match.index);
    const { text, count } = commaForDashes(gap);
    out += text + match[0];
    replaced += count;
    lastIndex = match.index + match[0].length;
  }
  const tail = commaForDashes(content.slice(lastIndex));
  out += tail.text;
  replaced += tail.count;
  return { content: out, replaced };
}
