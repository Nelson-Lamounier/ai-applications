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
});
