-- 051_dsa_topics.sql
-- Constraint-only DSA topic taxonomy + JD-signal mappings (NOT example content).
-- Global reference (no user_id, no RLS), frozen snapshot, idempotent ON CONFLICT.
-- Source: Tech Interview Handbook + NeetCode topic taxonomy + interviewing.io topic
-- frequency, retrieved 2026-06-01. Also seeds DSA gap-handling scaffolds.
BEGIN;

CREATE TABLE IF NOT EXISTS dsa_topics (
  canonical_name     TEXT PRIMARY KEY,
  display_name       TEXT NOT NULL,
  category           TEXT NOT NULL,
  jd_signal_keywords JSONB NOT NULL DEFAULT '[]'::jsonb,
  prerequisites      JSONB NOT NULL DEFAULT '[]'::jsonb,
  practice_pointer   TEXT,
  source             TEXT NOT NULL,
  as_of              DATE NOT NULL
);

INSERT INTO dsa_topics (canonical_name, display_name, category, jd_signal_keywords, prerequisites, practice_pointer, source, as_of) VALUES
('dsa_arrays_strings','Arrays & Strings','arrays_strings','["parsing","string processing","array","buffer"]'::jsonb,'[]'::jsonb,'leetcode.com/tag/array','Tech Interview Handbook, retrieved 2026-06-01','2026-06-01'),
('dsa_hashing','Hash Maps / Sets','hashing','["lookup","dedup","cache","index","frequency"]'::jsonb,'[]'::jsonb,'leetcode.com/tag/hash-table','Tech Interview Handbook, retrieved 2026-06-01','2026-06-01'),
('dsa_two_pointers','Two Pointers','arrays_strings','["sorted","in-place","partition"]'::jsonb,'["dsa_arrays_strings"]'::jsonb,'leetcode.com/tag/two-pointers','Tech Interview Handbook, retrieved 2026-06-01','2026-06-01'),
('dsa_sliding_window','Sliding Window','arrays_strings','["substring","subarray","streaming","window","rate"]'::jsonb,'["dsa_arrays_strings"]'::jsonb,'leetcode.com/tag/sliding-window','Tech Interview Handbook, retrieved 2026-06-01','2026-06-01'),
('dsa_binary_search','Binary Search','searching','["sorted","search","log n","threshold"]'::jsonb,'[]'::jsonb,'leetcode.com/tag/binary-search','Tech Interview Handbook, retrieved 2026-06-01','2026-06-01'),
('dsa_linked_list','Linked Lists','linked_list','["linked list","pointer","node"]'::jsonb,'[]'::jsonb,'leetcode.com/tag/linked-list','Tech Interview Handbook, retrieved 2026-06-01','2026-06-01'),
('dsa_stack_queue','Stacks & Queues','stack_queue','["stack","queue","LIFO","FIFO","parsing","expression"]'::jsonb,'[]'::jsonb,'leetcode.com/tag/stack','Tech Interview Handbook, retrieved 2026-06-01','2026-06-01'),
('dsa_trees','Trees & BST','trees','["tree","hierarchy","BST","traversal","DOM","filesystem"]'::jsonb,'["dsa_recursion"]'::jsonb,'leetcode.com/tag/tree','Tech Interview Handbook, retrieved 2026-06-01','2026-06-01'),
('dsa_tries','Tries','trees','["prefix","autocomplete","dictionary","search suggestion"]'::jsonb,'["dsa_trees"]'::jsonb,'leetcode.com/tag/trie','Tech Interview Handbook, retrieved 2026-06-01','2026-06-01'),
('dsa_heaps','Heaps / Priority Queues','heaps','["top k","priority","scheduling","ranking","median","streaming"]'::jsonb,'[]'::jsonb,'leetcode.com/tag/heap-priority-queue','Tech Interview Handbook, retrieved 2026-06-01','2026-06-01'),
('dsa_graph_traversal','Graph Traversal (BFS/DFS)','graphs','["graph","dependency","shortest path","network","relationship","traversal"]'::jsonb,'["dsa_recursion","dsa_stack_queue"]'::jsonb,'leetcode.com/tag/graph','Tech Interview Handbook, retrieved 2026-06-01','2026-06-01'),
('dsa_union_find','Union-Find','graphs','["connected components","grouping","disjoint","merge accounts"]'::jsonb,'["dsa_graph_traversal"]'::jsonb,'leetcode.com/tag/union-find','Tech Interview Handbook, retrieved 2026-06-01','2026-06-01'),
('dsa_topological_sort','Topological Sort','graphs','["dependency order","build order","scheduling","DAG"]'::jsonb,'["dsa_graph_traversal"]'::jsonb,'leetcode.com/tag/topological-sort','Tech Interview Handbook, retrieved 2026-06-01','2026-06-01'),
('dsa_recursion','Recursion','recursion','["recursive","divide and conquer","tree"]'::jsonb,'[]'::jsonb,'leetcode.com/tag/recursion','Tech Interview Handbook, retrieved 2026-06-01','2026-06-01'),
('dsa_backtracking','Backtracking','recursion','["combinations","permutations","constraint","search space"]'::jsonb,'["dsa_recursion"]'::jsonb,'leetcode.com/tag/backtracking','Tech Interview Handbook, retrieved 2026-06-01','2026-06-01'),
('dsa_dynamic_programming','Dynamic Programming','dynamic_programming','["optimi","maximi","minimi","count ways","subsequence","DP"]'::jsonb,'["dsa_recursion"]'::jsonb,'neetcode.io/roadmap','Tech Interview Handbook, retrieved 2026-06-01','2026-06-01'),
('dsa_greedy','Greedy','greedy','["interval","schedule","minimum number","optimi"]'::jsonb,'[]'::jsonb,'leetcode.com/tag/greedy','Tech Interview Handbook, retrieved 2026-06-01','2026-06-01'),
('dsa_intervals','Intervals','arrays_strings','["interval","merge","overlap","calendar","range"]'::jsonb,'["dsa_arrays_strings"]'::jsonb,'leetcode.com/tag/intervals','Tech Interview Handbook, retrieved 2026-06-01','2026-06-01'),
('dsa_sorting','Sorting & Comparators','sorting','["sort","order","ranking","comparator"]'::jsonb,'[]'::jsonb,'leetcode.com/tag/sorting','Tech Interview Handbook, retrieved 2026-06-01','2026-06-01'),
('dsa_bit_manipulation','Bit Manipulation','math','["bit","mask","XOR","binary","flags"]'::jsonb,'[]'::jsonb,'leetcode.com/tag/bit-manipulation','Tech Interview Handbook, retrieved 2026-06-01','2026-06-01'),
('dsa_matrix','Matrix / Grid','arrays_strings','["grid","matrix","2d","image","board"]'::jsonb,'["dsa_arrays_strings"]'::jsonb,'leetcode.com/tag/matrix','Tech Interview Handbook, retrieved 2026-06-01','2026-06-01'),
('dsa_concurrency','Concurrency Primitives','concurrency','["concurren","thread","lock","atomic","race","parallel"]'::jsonb,'[]'::jsonb,'leetcode.com/tag/concurrency','Tech Interview Handbook, retrieved 2026-06-01','2026-06-01'),
('dsa_complexity','Complexity Analysis','foundations','["scale","performance","latency","big o","efficient","optimi"]'::jsonb,'[]'::jsonb,'Tech Interview Handbook (complexity)','Tech Interview Handbook, retrieved 2026-06-01','2026-06-01')
ON CONFLICT (canonical_name) DO UPDATE SET
  display_name=EXCLUDED.display_name, category=EXCLUDED.category,
  jd_signal_keywords=EXCLUDED.jd_signal_keywords, prerequisites=EXCLUDED.prerequisites,
  practice_pointer=EXCLUDED.practice_pointer, source=EXCLUDED.source, as_of=EXCLUDED.as_of;

INSERT INTO prep_scaffolds (id, kind, title, structure, source, as_of) VALUES
('gap-dsa-adjacent','gap_handling','Bridge a DSA gap to a production pattern',
 '{"trigger":"dsa_topic_no_practice","template":"I have not drilled {topic} on LeetCode recently, but I have applied the underlying idea in production — {adjacent} in {project}. For an interview I would revisit {topic} on {practice_pointer}; here is how I would reason about it: {approach}."}'::jsonb,
 'UI-spec DSA honesty guidance','2026-06-01'),
('gap-dsa-practice','gap_handling','Acknowledge a DSA gap + commit to practice',
 '{"trigger":"dsa_topic_no_evidence","template":"That topic ({topic}) is likely on this round and I have not practiced it recently. I would allocate focused prep on {practice_pointer} before the interview rather than wing it."}'::jsonb,
 'UI-spec DSA honesty guidance','2026-06-01')
ON CONFLICT (id) DO UPDATE SET kind=EXCLUDED.kind, title=EXCLUDED.title, structure=EXCLUDED.structure, source=EXCLUDED.source, as_of=EXCLUDED.as_of;

COMMIT;
