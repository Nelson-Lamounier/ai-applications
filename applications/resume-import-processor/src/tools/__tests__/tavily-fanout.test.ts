import { describe, it, expect, jest } from '@jest/globals';
import {
  fanOutRoleSearches,
  recencyKey,
  MAX_SEARCHED_ROLES,
  type FanoutRole,
} from '../tavily-fanout.js';
import type { SearchResult, WebSearchTool } from '../tavily.js';

const RESULT: SearchResult[] = [{ title: 't', url: 'u', content: 'c', score: 1 }];
const log = { info: jest.fn() };

function role(n: number, period = '2020-2023'): FanoutRole {
  return { roleId: `r${n}`, company: `Co${n}`, title: `Title ${n}`, period };
}

describe('recencyKey', () => {
  it('treats open-ended periods as most recent', () => {
    expect(recencyKey('2019 - Present')).toBe(Number.MAX_SAFE_INTEGER);
    expect(recencyKey('Jan 2021 – current')).toBe(Number.MAX_SAFE_INTEGER);
  });
  it('returns the latest year mentioned', () => {
    expect(recencyKey('Jan 2018 - Mar 2022')).toBe(2022);
    expect(recencyKey('2020')).toBe(2020);
  });
  it('returns -Infinity for unparseable periods', () => {
    expect(recencyKey('a while ago')).toBe(Number.NEGATIVE_INFINITY);
  });
});

describe('fanOutRoleSearches', () => {
  it('returns empty for no roles', async () => {
    const tool = { search: jest.fn() } as unknown as WebSearchTool;
    const res = await fanOutRoleSearches([], tool, log);
    expect(res.outcomes).toEqual([]);
    expect(res.budgetExceeded).toBe(false);
  });

  it('maps non-empty / empty / thrown into ok / empty / failed and never throws', async () => {
    const search = jest.fn(async (q: unknown) => {
      const query = String(q);
      if (query.includes('Title 1')) return RESULT;
      if (query.includes('Title 2')) return [];
      throw new Error('tavily 500');
    });
    const tool = { search } as unknown as WebSearchTool;

    const res = await fanOutRoleSearches([role(1), role(2), role(3)], tool, log);

    const byId = Object.fromEntries(res.outcomes.map((o) => [o.roleId, o.status]));
    expect(byId).toEqual({ r1: 'ok', r2: 'empty', r3: 'failed' });
  });

  it('caps to the most-recent MAX_SEARCHED_ROLES and tags the rest skipped_budget', async () => {
    const search = jest.fn(async () => RESULT);
    const tool = { search } as unknown as WebSearchTool;

    // 8 roles, ascending years → oldest two should be skipped.
    const roles = [
      role(1, '2015'), role(2, '2016'), role(3, '2017'), role(4, '2018'),
      role(5, '2019'), role(6, '2020'), role(7, '2021'), role(8, '2022'),
    ];
    const res = await fanOutRoleSearches(roles, tool, log);

    expect(res.outcomes).toHaveLength(8);
    expect(search).toHaveBeenCalledTimes(MAX_SEARCHED_ROLES); // only 6 searched

    const skipped = res.outcomes.filter((o) => o.status === 'skipped_budget').map((o) => o.roleId);
    // Oldest two (2015, 2016) skipped
    expect(skipped.sort()).toEqual(['r1', 'r2']);

    const searchedIds = res.outcomes.filter((o) => o.status === 'ok').map((o) => o.roleId).sort();
    expect(searchedIds).toEqual(['r3', 'r4', 'r5', 'r6', 'r7', 'r8']);
  });

  it('every input role appears exactly once in outcomes', async () => {
    const search = jest.fn(async () => RESULT);
    const tool = { search } as unknown as WebSearchTool;
    const roles = Array.from({ length: 10 }, (_, i) => role(i, String(2010 + i)));

    const res = await fanOutRoleSearches(roles, tool, log);

    expect(res.outcomes).toHaveLength(10);
    expect(new Set(res.outcomes.map((o) => o.roleId)).size).toBe(10);
  });

  it('passes an AbortSignal into the search tool', async () => {
    const search = jest.fn(async (_q: unknown, _n: unknown, signal: unknown) => {
      expect(signal).toBeInstanceOf(AbortSignal);
      return RESULT;
    });
    const tool = { search } as unknown as WebSearchTool;
    await fanOutRoleSearches([role(1)], tool, log);
    expect(search).toHaveBeenCalled();
  });
});
