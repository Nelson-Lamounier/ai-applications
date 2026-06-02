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
  it('5. inline sort in an algo-context path → dsa_sorting @0.70', () => {
    expect(detectDsaPatterns('xs.sort(key=lambda x: x.cost)\n', 'python', 'algorithms/greedy/s.py')[0])
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

describe('detectDsaPatterns — comparator FP-gate (2026-06-02)', () => {
  // (a) Authored-comparator markers fire regardless of path (≈0 web FP).
  it('python cmp_to_key (any path) → comparator', () => {
    expect(detectDsaPatterns('ys = sorted(xs, key=cmp_to_key(mycmp))\n', 'python', 'util.py')[0])
      .toMatchObject({ topic_hint: 'dsa_sorting', signal: 'comparator', confidence: 0.70 });
  });
  it('java implements Comparator (any path) → comparator', () => {
    expect(detectDsaPatterns('class ByAge implements Comparator<P> {\n', 'java', 'Main.java')[0])
      .toMatchObject({ topic_hint: 'dsa_sorting', signal: 'comparator' });
  });
  it('java implements Comparable (any path) → comparator', () => {
    expect(detectDsaPatterns('public class P implements Comparable<P> {\n', 'java', 'P.java')[0])
      .toMatchObject({ topic_hint: 'dsa_sorting', signal: 'comparator' });
  });
  it('java compareTo override (any path) → comparator', () => {
    expect(detectDsaPatterns('    public int compareTo(P o) { return 0; }\n', 'java', 'P.java')[0])
      .toMatchObject({ topic_hint: 'dsa_sorting', signal: 'comparator' });
  });

  // (b) Inline sort idioms fire ONLY in an algorithm-named path.
  it('python inline keyed sort in algorithms/ path → comparator', () => {
    expect(detectDsaPatterns('intervals.sort(key=lambda i: i.start)\n', 'python', 'algorithms/array/merge_intervals.py')[0])
      .toMatchObject({ topic_hint: 'dsa_sorting', signal: 'comparator' });
  });
  it('ts inline comparator in src/algorithms path → comparator', () => {
    expect(detectDsaPatterns('arr.sort((a, b) => a - b)\n', 'typescript', 'src/algorithms/quicksort.ts')[0])
      .toMatchObject({ topic_hint: 'dsa_sorting', signal: 'comparator' });
  });
  it('java Comparator.thenComparing in data_structures path → comparator', () => {
    expect(detectDsaPatterns('Comparator.comparing(P::a).thenComparing(P::b);\n', 'java', 'data_structures/Heap.java')[0])
      .toMatchObject({ topic_hint: 'dsa_sorting', signal: 'comparator' });
  });

  // FP killers — the web-app sorts that broke the gate now emit NOTHING.
  it('NEGATIVE: ts web sort in src/retrieval.ts → nothing', () => {
    expect(detectDsaPatterns('items.sort((a, b) => b.score - a.score)\n', 'typescript', 'src/retrieval.ts')).toEqual([]);
  });
  it('NEGATIVE: ts multi-key web sort in a component → nothing', () => {
    expect(detectDsaPatterns('rows.sort((a, b) => b.x - a.x || a.y - b.y)\n', 'typescript', 'app/components/Dashboard.tsx')).toEqual([]);
  });
  it('NEGATIVE: python keyed sort in a non-algo path → nothing', () => {
    expect(detectDsaPatterns('users.sort(key=lambda x: x.name)\n', 'python', 'app/models.py')).toEqual([]);
  });
  it('NEGATIVE: bare Comparator.comparing outside algo path → nothing', () => {
    expect(detectDsaPatterns('users.sort(Comparator.comparing(User::getName));\n', 'java', 'src/UserService.java')).toEqual([]);
  });
});
