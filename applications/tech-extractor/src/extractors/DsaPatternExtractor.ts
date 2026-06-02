/** @format */
export type DsaLang = 'python' | 'typescript' | 'javascript' | 'java';

export interface RawDsaEvidence {
  readonly raw_name: string;
  readonly topic_hint: string;
  readonly signal: string;
  readonly confidence: number;
  readonly file_path: string;
  readonly line_start: number;
}

const DSA_EXT_LANG: Record<string, DsaLang> = {
  '.py': 'python', '.ts': 'typescript', '.tsx': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript', '.java': 'java',
};
export function dsaLangForExt(ext: string): DsaLang | null { return DSA_EXT_LANG[ext] ?? null; }

// Each detector returns matches for ONE line. Keep patterns sufficient-not-necessary.
type Detector = (line: string, lang: DsaLang) => Omit<RawDsaEvidence, 'file_path' | 'line_start'> | null;

const networkx: Detector = (l, lang) =>
  lang === 'python' && /(^|\s)(import\s+networkx|from\s+networkx\s+import)\b/.test(l)
    ? { raw_name: 'networkx', topic_hint: 'dsa_graph_traversal', signal: 'networkx_import', confidence: 0.80 } : null;

const heap: Detector = (l, lang) => {
  if (lang === 'python' && /(^|\s)(import\s+heapq|from\s+heapq\s+import|from\s+queue\s+import\s+PriorityQueue)\b/.test(l))
    return { raw_name: 'heapq', topic_hint: 'dsa_heaps', signal: 'heap', confidence: 0.78 };
  if (lang === 'java' && /\bimport\s+java\.util\.PriorityQueue\b/.test(l))
    return { raw_name: 'PriorityQueue', topic_hint: 'dsa_heaps', signal: 'heap', confidence: 0.78 };
  return null;
};

const TREE_TYPES = /\b(class|interface|struct)\s+(TreeNode|BinaryTree|AVLTree|RedBlackTree|SegmentTree|TrieNode|Trie)\b/;
const treeType: Detector = (l) => {
  const m = TREE_TYPES.exec(l);
  if (!m) return null;
  const isTrie = /Trie/.test(m[2]);
  return { raw_name: m[2], topic_hint: isTrie ? 'dsa_tries' : 'dsa_trees', signal: 'tree_type', confidence: 0.75 };
};

const memoization: Detector = (l, lang) =>
  (lang === 'python' || lang === 'typescript' || lang === 'javascript') &&
  /^\s*@(functools\.)?(lru_cache|cache|memoize|memo)\b/.test(l)
    ? { raw_name: 'memoize', topic_hint: 'dsa_dynamic_programming', signal: 'memoization', confidence: 0.72 } : null;

const comparator: Detector = (l, lang) => {
  if ((lang === 'python') && /\.sort\(\s*key\s*=|(^|\W)sorted\([^)]*\bkey\s*=/.test(l))
    return { raw_name: 'comparator', topic_hint: 'dsa_sorting', signal: 'comparator', confidence: 0.70 };
  if ((lang === 'java') && /Comparator\.(comparing|reverseOrder)|\.compare\s*\(/.test(l))
    return { raw_name: 'comparator', topic_hint: 'dsa_sorting', signal: 'comparator', confidence: 0.70 };
  if ((lang === 'typescript' || lang === 'javascript') && /\.sort\(\s*\([^)]*\)\s*=>|\bcompareFn\b/.test(l))
    return { raw_name: 'comparator', topic_hint: 'dsa_sorting', signal: 'comparator', confidence: 0.70 };
  return null;
};

const DETECTORS: Detector[] = [networkx, heap, treeType, memoization, comparator];

export function detectDsaPatterns(src: string, lang: DsaLang, filePath: string): RawDsaEvidence[] {
  const out: RawDsaEvidence[] = [];
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const d of DETECTORS) {
      const hit = d(lines[i], lang);
      if (hit) out.push({ ...hit, file_path: filePath, line_start: i + 1 });
    }
  }
  return out;
}

export class DsaPatternExtractor {
  readonly name = 'dsa-pattern';
  constructor(
    private readonly readFile: (rel: string) => Promise<string>,
    private readonly files: string[],
  ) {}
  async extract(): Promise<RawDsaEvidence[]> {
    const out: RawDsaEvidence[] = [];
    for (const rel of this.files) {
      const lang = dsaLangForExt(rel.slice(rel.lastIndexOf('.')));
      if (!lang) continue;
      out.push(...detectDsaPatterns(await this.readFile(rel), lang, rel));
    }
    return out;
  }
}
