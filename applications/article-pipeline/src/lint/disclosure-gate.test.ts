import { describe, it, expect } from '@jest/globals';
import { hasDisclosureBlocker } from './disclosure-gate.js';

describe('hasDisclosureBlocker', () => {
  it('blocks when an identifier-leak error is present', () => {
    expect(hasDisclosureBlocker([
      { rule: 'identifier-leak:public-hostname', severity: 'error', message: 'x' },
    ])).toBe(true);
  });
  it('does not block on a warn-level security-claim finding', () => {
    expect(hasDisclosureBlocker([
      { rule: 'security-claim-unverified', severity: 'warn', message: 'x' },
    ])).toBe(false);
  });
  it('ignores unrelated error findings', () => {
    expect(hasDisclosureBlocker([
      { rule: 'dead-link', severity: 'error', message: 'x' },
    ])).toBe(false);
  });
});
