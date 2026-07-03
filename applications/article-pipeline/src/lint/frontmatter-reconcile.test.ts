/**
 * @format
 * Tests for the deterministic frontmatter/prose normaliser.
 */
import {
  computeReadingTime,
  reconcileFrontmatter,
  stripProseEmDashes,
} from './frontmatter-reconcile';

const FM = [
  '---',
  'title: "A Title"',
  'description: "desc"',
  'tags: ["a", "b"]',
  'slug: "writer-invented-slug"',
  'publishDate: "2026-06-18"',
  'author: "Nelson Lamounier"',
  'category: "Cloud"',
  'readingTime: 9',
  '---',
  '',
  '## Intro',
  'Body text here.',
].join('\n');

describe('reconcileFrontmatter', () => {
  const canonical = { slug: 'canonical-slug', publishDate: '2026-07-03', readingTime: 12 };

  it('overwrites slug, publishDate and readingTime with canonical values', () => {
    const out = reconcileFrontmatter(FM, canonical);
    expect(out).toContain('slug: "canonical-slug"');
    expect(out).toContain('publishDate: "2026-07-03"');
    expect(out).toContain('readingTime: 12');
    expect(out).not.toContain('writer-invented-slug');
    expect(out).not.toContain('2026-06-18');
    expect(out).not.toContain('readingTime: 9');
  });

  it('preserves all other frontmatter fields and the body', () => {
    const out = reconcileFrontmatter(FM, canonical);
    expect(out).toContain('title: "A Title"');
    expect(out).toContain('description: "desc"');
    expect(out).toContain('tags: ["a", "b"]');
    expect(out).toContain('author: "Nelson Lamounier"');
    expect(out).toContain('category: "Cloud"');
    expect(out).toContain('## Intro');
    expect(out).toContain('Body text here.');
  });

  it('inserts a missing key rather than dropping it', () => {
    const noSlug = FM.replace('slug: "writer-invented-slug"\n', '');
    const out = reconcileFrontmatter(noSlug, canonical);
    expect(out).toContain('slug: "canonical-slug"');
    // still a valid single frontmatter block
    expect(out.match(/^---$/gm)?.length).toBe(2);
  });

  it('returns content unchanged when there is no frontmatter block', () => {
    const bare = '## Just a heading\n\nNo frontmatter.';
    expect(reconcileFrontmatter(bare, canonical)).toBe(bare);
  });

  it('does not rewrite a slug-like string in the body', () => {
    const out = reconcileFrontmatter(FM, canonical);
    // only the frontmatter slug line changed; body untouched
    expect(out.endsWith('Body text here.')).toBe(true);
  });
});

describe('computeReadingTime', () => {
  it('counts prose words at ~200 wpm, rounding up', () => {
    const body = '---\ntitle: "x"\n---\n\n' + Array.from({ length: 400 }, () => 'word').join(' ');
    expect(computeReadingTime(body)).toBe(2);
  });

  it('excludes fenced code from the count', () => {
    const prose = Array.from({ length: 200 }, () => 'word').join(' ');
    const code = '```ts\n' + Array.from({ length: 5000 }, () => 'const x = 1;').join('\n') + '\n```';
    expect(computeReadingTime(`${prose}\n\n${code}`)).toBe(1);
  });

  it('never returns less than 1 minute', () => {
    expect(computeReadingTime('tiny')).toBe(1);
  });
});

describe('stripProseEmDashes', () => {
  it('replaces spaced em-dash connectors with a comma', () => {
    const r = stripProseEmDashes('The system has two layers — a verifier and a guard.');
    expect(r.content).toBe('The system has two layers, a verifier and a guard.');
    expect(r.replaced).toBe(1);
  });

  it('handles double em-dash parentheticals', () => {
    const r = stripProseEmDashes('It runs in two stages — validation then deploy — keeping failures isolated.');
    expect(r.content).toBe('It runs in two stages, validation then deploy, keeping failures isolated.');
    expect(r.replaced).toBe(2);
  });

  it('leaves em-dashes inside fenced code untouched', () => {
    const src = 'Prose here — changed.\n```bash\naws foo --model-id x — bar\n```';
    const r = stripProseEmDashes(src);
    expect(r.content).toContain('aws foo --model-id x — bar');
    expect(r.content).toContain('Prose here, changed.');
    expect(r.replaced).toBe(1);
  });

  it('leaves inline code and MDX components untouched', () => {
    const src = 'Use `a — b` verbatim but rewrite this — connector.';
    const r = stripProseEmDashes(src);
    expect(r.content).toContain('`a — b`');
    expect(r.content).toContain('rewrite this, connector.');
    expect(r.replaced).toBe(1);
  });

  it('does not touch glued em-dashes or hyphenated words', () => {
    const r = stripProseEmDashes('state-of-the-art and word—word stay.');
    expect(r.content).toBe('state-of-the-art and word—word stay.');
    expect(r.replaced).toBe(0);
  });
});
