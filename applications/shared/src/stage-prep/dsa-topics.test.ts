/** @format */
import { describe, it, expect, jest } from '@jest/globals';
import { RdsDsaTopicRepository } from './dsa-topics.js';

function fakePool(rows: unknown[]) {
  const query = jest.fn(async () => ({ rows }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { pool: { query } as any, query };
}

describe('RdsDsaTopicRepository.listTopics', () => {
  it('maps rows to DsaTopic', async () => {
    const { pool } = fakePool([{
      canonical_name: 'dsa_graph_traversal', display_name: 'Graph traversal (BFS/DFS)',
      category: 'graphs', jd_signal_keywords: ['graph','dependency'], prerequisites: ['dsa_recursion'],
      practice_pointer: 'leetcode.com/tag/graph',
    }]);
    const out = await new RdsDsaTopicRepository(pool).listTopics();
    expect(out[0]).toMatchObject({ canonicalName: 'dsa_graph_traversal', category: 'graphs', jdSignalKeywords: ['graph','dependency'], prerequisites: ['dsa_recursion'], practicePointer: 'leetcode.com/tag/graph' });
  });
  it('returns [] when empty', async () => {
    const { pool } = fakePool([]);
    expect(await new RdsDsaTopicRepository(pool).listTopics()).toEqual([]);
  });
  it('listByCategory filters by category param', async () => {
    const { pool, query } = fakePool([]);
    await new RdsDsaTopicRepository(pool).listByCategory('graphs');
    const sql = query.mock.calls[0]![0] as string;
    expect(sql).toMatch(/WHERE category = \$1/);
  });
});
