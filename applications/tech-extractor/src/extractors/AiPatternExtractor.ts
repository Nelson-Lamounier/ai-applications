/** @format */
export type AiLang = 'python' | 'typescript' | 'javascript';

export interface RawAiEvidence {
  readonly raw_name: string;
  readonly topic_hint: string;
  readonly signal: string;
  readonly confidence: number;
  readonly file_path: string;
  readonly line_start: number;
}

const AI_EXT_LANG: Record<string, AiLang> = {
  '.py': 'python', '.ts': 'typescript', '.tsx': 'typescript', '.js': 'javascript', '.jsx': 'javascript',
};
export function aiLangForExt(ext: string): AiLang | null { return AI_EXT_LANG[ext] ?? null; }

const lineOf = (src: string, index: number): number => src.slice(0, index).split('\n').length;

/** Detect AI practice signals. `lang` may be null (e.g. .json eval files). */
export function detectAiPatterns(src: string, lang: AiLang | null, filePath: string): RawAiEvidence[] {
  const out: RawAiEvidence[] = [];
  const codeLang = lang === 'python' || lang === 'typescript' || lang === 'javascript';

  // 1. prompt caching — cachePoint as an object key (not a comment/string mention)
  if (codeLang) {
    const m = /(^|[\s,{])["']?cachePoint["']?\s*:/m.exec(src);
    if (m) out.push({ raw_name: 'cachePoint', topic_hint: 'ai_prompt_caching', signal: 'prompt_caching', confidence: 0.78, file_path: filePath, line_start: lineOf(src, m.index) });
  }

  // 2. MCP integration — official SDK import AND a tools call-site (not lockfile/package.json)
  if (codeLang && /@modelcontextprotocol\/sdk/.test(src)) {
    const call = /(tools\/(list|call)|\.listTools\(|\.callTool\(|CallToolRequest|server\.tool\(|\.setRequestHandler\()/.exec(src);
    if (call) out.push({ raw_name: 'mcp', topic_hint: 'ai_mcp_integration', signal: 'mcp_integration', confidence: 0.80, file_path: filePath, line_start: lineOf(src, call.index) });
  }

  // 3. grounding/verification — named class/interface AND body references source/context (not a stub)
  if (codeLang) {
    const cls = /\b(class|interface)\s+(\w*(?:Grounding|Verifier|Hallucination)\w*)/.exec(src);
    if (cls) {
      const body = src.slice(cls.index, cls.index + 2000);
      if (/\b(source|context|citation|grounded|reference|faithful)\b/i.test(body.slice(cls[0].length))) {
        out.push({ raw_name: cls[2], topic_hint: 'ai_grounding', signal: 'grounding', confidence: 0.70, file_path: filePath, line_start: lineOf(src, cls.index) });
      }
    }
  }

  // 4. eval harness — an eval(s) json file whose content matches {prompt, expected*} with >=3 cases
  if (/(^|\/)evals?\b/i.test(filePath) && /\.json$/i.test(filePath)) {
    try {
      const data: unknown = JSON.parse(src);
      const arr = Array.isArray(data) ? data
        : (Array.isArray((data as Record<string, unknown>)?.['cases']) ? (data as Record<string, unknown>)['cases'] as unknown[]
        : (Array.isArray((data as Record<string, unknown>)?.['tests']) ? (data as Record<string, unknown>)['tests'] as unknown[] : null));
      const ok = Array.isArray(arr) && arr.length >= 3 && arr.every((c) =>
        c !== null && typeof c === 'object' && 'prompt' in (c as object) &&
        (['expected', 'expected_output', 'ideal', 'reference'].some((k) => k in (c as object))));
      if (ok) out.push({ raw_name: 'evals', topic_hint: 'ai_eval_quality', signal: 'eval_harness', confidence: 0.75, file_path: filePath, line_start: 1 });
    } catch { /* not JSON → not an eval harness */ }
  }

  // 5. cost engineering — token-usage field AND a price/cost computation within a 3-line window
  if (codeLang) {
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const win = lines.slice(i, i + 3).join('\n');
      if (/(inputTokens|input_tokens|promptTokens|output_?[Tt]okens|\busage\b)/.test(win)
        && /(\*\s*0?\.\d|\bcost\b|\bprice\b|\busd\b|per[_-]?token|recordBedrockCost|recordCost)/i.test(win)) {
        out.push({ raw_name: 'cost', topic_hint: 'ai_cost_engineering', signal: 'cost_engineering', confidence: 0.70, file_path: filePath, line_start: i + 1 });
        break;
      }
    }
  }
  return out;
}

export class AiPatternExtractor {
  readonly name = 'ai-pattern';
  constructor(
    private readonly readFile: (rel: string) => Promise<string>,
    private readonly files: string[],
  ) {}
  async extract(): Promise<RawAiEvidence[]> {
    const out: RawAiEvidence[] = [];
    for (const rel of this.files) {
      const ext = rel.slice(rel.lastIndexOf('.'));
      const lang = aiLangForExt(ext);
      // Code files OR json files (eval harness). Skip everything else.
      if (!lang && ext !== '.json') continue;
      out.push(...detectAiPatterns(await this.readFile(rel), lang, rel));
    }
    return out;
  }
}
