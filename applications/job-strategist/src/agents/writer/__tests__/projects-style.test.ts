/** @format */
import { describe, it, expect } from '@jest/globals';
import { checkComposedBulletStyle } from '../projects-style.js';

describe('checkComposedBulletStyle', () => {
  it('flags an internal identifier (SNAKE_CASE env-var-shaped token) -- the '
    + 'run fe421faf leak, "(RETRIEVAL_PREFILTER)"', () => {
    const findings = checkComposedBulletStyle(
      'Reduced retrieval latency by tuning the (RETRIEVAL_PREFILTER) stage for every query.',
    );
    expect(findings).toContainEqual({ kind: 'internal_identifier', token: 'RETRIEVAL_PREFILTER' });
  });

  it('flags bare plus-numeric tokens -- "100+" and "12k+" both flagged', () => {
    const findings = checkComposedBulletStyle(
      'Indexed more than 100+ documents per batch, scaling to 12k+ vectors overall.',
    );
    const tokens = findings.filter((f) => f.kind === 'bare_plus_numeric').map((f) => f.token);
    expect(tokens).toContain('100+');
    expect(tokens).toContain('12k+');
  });

  it('flags a code-call token -- "sanitizeMdx()"', () => {
    const findings = checkComposedBulletStyle('Escaped every rendered field through sanitizeMdx() before display.');
    expect(findings).toContainEqual({ kind: 'code_call', token: 'sanitizeMdx()' });
  });

  it('a clean four-beat bullet (WHAT -> CONCEPT -> WHY -> RESULT, public vocabulary, no jargon) passes with zero findings', () => {
    const findings = checkComposedBulletStyle(
      'Built an approximate-nearest-neighbour search index to keep retrieval latency low under load, '
        + 'cutting median query time by more than 40 percent.',
    );
    expect(findings).toEqual([]);
  });

  it('flags every occurrence when the same kind appears more than once in one bullet', () => {
    const findings = checkComposedBulletStyle(
      'Wired RETRIEVAL_PREFILTER alongside EMBEDDING_CACHE_TTL to cut lookup time.',
    );
    expect(findings).toHaveLength(2);
    expect(findings.map((f) => f.token).sort()).toEqual(['EMBEDDING_CACHE_TTL', 'RETRIEVAL_PREFILTER']);
  });

  it('does not flag an ordinary capitalised acronym used as a normal word (e.g. "AWS", "API") -- '
    + 'only SNAKE_CASE multi-segment tokens and code-call syntax are structurally caught, never a bare acronym '
    + '(unintroduced-acronym detection is deliberately out of scope for this lint)', () => {
    const findings = checkComposedBulletStyle('Deployed the API on AWS behind a managed load balancer.');
    expect(findings).toEqual([]);
  });

  it('an empty string yields zero findings', () => {
    expect(checkComposedBulletStyle('')).toEqual([]);
  });
});
