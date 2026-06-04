/** @format */
import { describe, it, expect } from 'vitest';
import { assertDevTarget, isSelectOnly } from '../guards.js';

describe('assertDevTarget', () => {
  it('passes for the pinned dev target', () => {
    expect(() => assertDevTarget({ account: '771826808455', region: 'eu-west-1', db: 'tucaken' })).not.toThrow();
  });
  it('throws for any other account/region/db', () => {
    expect(() => assertDevTarget({ account: '999', region: 'eu-west-1', db: 'tucaken' })).toThrow(/account/);
    expect(() => assertDevTarget({ account: '771826808455', region: 'us-east-1', db: 'tucaken' })).toThrow(/region/);
    expect(() => assertDevTarget({ account: '771826808455', region: 'eu-west-1', db: 'prod' })).toThrow(/db/);
  });
});

describe('isSelectOnly', () => {
  it('accepts SELECT / WITH ... SELECT', () => {
    expect(isSelectOnly('SELECT 1')).toBe(true);
    expect(isSelectOnly('  with x as (select 1) select * from x')).toBe(true);
  });
  it('rejects writes + multi-statement', () => {
    for (const s of ['UPDATE t SET a=1', 'delete from t', 'INSERT INTO t VALUES(1)', 'DROP TABLE t',
                     'SELECT 1; DROP TABLE t', 'truncate t']) expect(isSelectOnly(s)).toBe(false);
  });
});
