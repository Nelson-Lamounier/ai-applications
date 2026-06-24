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
