import { describe, it, expect } from '@jest/globals';
import { detectDsaPatterns } from './DsaPatternExtractor.js';

describe('detectDsaPatterns — admissible signals', () => {
  it('1. networkx import → dsa_graph_traversal @0.80 with line', () => {
    const out = detectDsaPatterns('import os\nimport networkx as nx\n', 'python', 'g.py');
    expect(out).toEqual([{ raw_name: 'networkx', topic_hint: 'dsa_graph_traversal',
      signal: 'networkx_import', confidence: 0.80, file_path: 'g.py', line_start: 2 }]);
  });
  it('2. heapq / PriorityQueue → dsa_heaps @0.78', () => {
    expect(detectDsaPatterns('import heapq\n', 'python', 'h.py')[0]).toMatchObject(
      { topic_hint: 'dsa_heaps', signal: 'heap', confidence: 0.78 });
    expect(detectDsaPatterns('from queue import PriorityQueue\n', 'python', 'h.py')[0])
      .toMatchObject({ topic_hint: 'dsa_heaps' });
    expect(detectDsaPatterns('import java.util.PriorityQueue;\n', 'java', 'H.java')[0])
      .toMatchObject({ topic_hint: 'dsa_heaps' });
  });
  it('3. explicit tree/trie type def → dsa_trees / dsa_tries @0.75', () => {
    expect(detectDsaPatterns('class TreeNode:\n    pass\n', 'python', 't.py')[0])
      .toMatchObject({ topic_hint: 'dsa_trees', signal: 'tree_type', confidence: 0.75 });
    expect(detectDsaPatterns('class TrieNode {}\n', 'typescript', 't.ts')[0])
      .toMatchObject({ topic_hint: 'dsa_tries' });
  });
  it('4. declarative memoization decorator → dsa_dynamic_programming @0.72', () => {
    expect(detectDsaPatterns('@functools.lru_cache(None)\ndef f(): ...\n', 'python', 'm.py')[0])
      .toMatchObject({ topic_hint: 'dsa_dynamic_programming', signal: 'memoization', confidence: 0.72 });
    expect(detectDsaPatterns('@cache\ndef f(): ...\n', 'python', 'm.py').length).toBe(1);
  });
  it('5. custom comparator sort → dsa_sorting @0.70', () => {
    expect(detectDsaPatterns('xs.sort(key=lambda x: x.cost)\n', 'python', 's.py')[0])
      .toMatchObject({ topic_hint: 'dsa_sorting', signal: 'comparator', confidence: 0.70 });
  });
});

describe('detectDsaPatterns — do NOT detect (necessary-not-sufficient)', () => {
  it('sliding window range/len → nothing', () =>
    expect(detectDsaPatterns('for i in range(len(a)):\n    w = a[i:i+k]\n', 'python', 'x.py')).toEqual([]));
  it('dp[] / nested loops → nothing', () =>
    expect(detectDsaPatterns('dp = [[0]*n for _ in range(m)]\n', 'python', 'x.py')).toEqual([]));
  it('plain recursion → nothing', () =>
    expect(detectDsaPatterns('def walk(d):\n    walk(d.parent)\n', 'python', 'x.py')).toEqual([]));
  it('generic deque/Queue → nothing', () => {
    expect(detectDsaPatterns('from collections import deque\n', 'python', 'x.py')).toEqual([]);
    expect(detectDsaPatterns('import java.util.Queue;\n', 'java', 'X.java')).toEqual([]);
  });
  it('generic stack via list.append/pop, set ops → nothing', () =>
    expect(detectDsaPatterns('s=[]\ns.append(1)\ns.pop()\nseen=set()\n', 'python', 'x.py')).toEqual([]));
  it('plain sort without comparator → nothing', () =>
    expect(detectDsaPatterns('xs.sort()\nsorted(xs)\n', 'python', 'x.py')).toEqual([]));
  // Regression: false positives caught in adversarial review (2026-06-02).
  it('Flask-Caching @cache.cached / @cache.memoize → nothing', () => {
    expect(detectDsaPatterns('@cache.cached(timeout=300)\ndef view(): ...\n', 'python', 'v.py')).toEqual([]);
    expect(detectDsaPatterns('@cache.memoize()\ndef view(): ...\n', 'python', 'v.py')).toEqual([]);
  });
  it('commented-out networkx / heapq imports → nothing', () => {
    expect(detectDsaPatterns('# import networkx as nx\n', 'python', 'g.py')).toEqual([]);
    expect(detectDsaPatterns('# import heapq\n', 'python', 'h.py')).toEqual([]);
  });
  it('Java util method named compare (not a Comparator) → nothing', () =>
    expect(detectDsaPatterns('int r = VersionUtil.compare(a, b);\n', 'java', 'X.java')).toEqual([]));
});
