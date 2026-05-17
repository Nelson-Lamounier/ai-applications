/** @format */
import { assertSafeToMutate } from '../rds-client';

describe('assertSafeToMutate', () => {
  const okUser = '31f4686a-979b-4765-a17c-22a1e71cec59';

  it('passes for the dev db + a uuid test user', () => {
    expect(() => assertSafeToMutate('tucaken', okUser)).not.toThrow();
  });
  it('aborts when the db is not the dev database', () => {
    expect(() => assertSafeToMutate('tucaken_prod', okUser)).toThrow(/refusing.*database/i);
  });
  it('aborts when the test user id is empty', () => {
    expect(() => assertSafeToMutate('tucaken', '')).toThrow(/test user/i);
  });
  it('aborts when the test user id is not a uuid', () => {
    expect(() => assertSafeToMutate('tucaken', 'admin')).toThrow(/test user/i);
  });

  it('fails closed when SMOKE_ALLOWED_DBS is set empty (no [""] bypass)', () => {
    const prev = process.env.SMOKE_ALLOWED_DBS;
    process.env.SMOKE_ALLOWED_DBS = '';
    try {
      expect(() => assertSafeToMutate('', okUser)).toThrow(/refusing.*database/i);
      expect(() => assertSafeToMutate('tucaken', okUser)).not.toThrow(); // default restored
    } finally {
      if (prev === undefined) delete process.env.SMOKE_ALLOWED_DBS;
      else process.env.SMOKE_ALLOWED_DBS = prev;
    }
  });

  it('ignores blank entries from a trailing comma', () => {
    const prev = process.env.SMOKE_ALLOWED_DBS;
    process.env.SMOKE_ALLOWED_DBS = 'tucaken,';
    try {
      expect(() => assertSafeToMutate('', okUser)).toThrow(/refusing.*database/i);
      expect(() => assertSafeToMutate('tucaken', okUser)).not.toThrow();
    } finally {
      if (prev === undefined) delete process.env.SMOKE_ALLOWED_DBS;
      else process.env.SMOKE_ALLOWED_DBS = prev;
    }
  });

  it('respects a runtime SMOKE_ALLOWED_DBS override (read per-call)', () => {
    const prev = process.env.SMOKE_ALLOWED_DBS;
    process.env.SMOKE_ALLOWED_DBS = 'tucaken_dev2';
    try {
      expect(() => assertSafeToMutate('tucaken_dev2', okUser)).not.toThrow();
    } finally {
      if (prev === undefined) delete process.env.SMOKE_ALLOWED_DBS;
      else process.env.SMOKE_ALLOWED_DBS = prev;
    }
  });

  it('aborts when the db name has leading/trailing whitespace', () => {
    expect(() => assertSafeToMutate(' tucaken', okUser)).toThrow(/refusing.*database/i);
  });
});
