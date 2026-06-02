/** @format */
import { describe, it, expect } from '@jest/globals';
import { detectAiPatterns } from './AiPatternExtractor.js';

describe('detectAiPatterns — admissible', () => {
  it('cachePoint in a payload → ai_prompt_caching', () => {
    const out = detectAiPatterns('const body = {\n  messages,\n  cachePoint: { type: "default" },\n};\n', 'typescript', 'bedrock.ts');
    expect(out[0]).toMatchObject({ topic_hint: 'ai_prompt_caching', signal: 'prompt_caching', confidence: 0.78, line_start: 3 });
  });
  it('MCP import + call-site → ai_mcp_integration', () => {
    const src = "import { Client } from '@modelcontextprotocol/sdk/client/index.js';\nconst t = await client.callTool({ name: 'x' });\n";
    expect(detectAiPatterns(src, 'typescript', 'mcp.ts')[0]).toMatchObject({ topic_hint: 'ai_mcp_integration', signal: 'mcp_integration', confidence: 0.80 });
  });
  it('grounding class with source-referencing body → ai_grounding', () => {
    const src = 'class BedrockGroundingVerifier {\n  verify(out: string, context: string) { return context.includes(out); }\n}\n';
    expect(detectAiPatterns(src, 'typescript', 'g.ts')[0]).toMatchObject({ topic_hint: 'ai_grounding', signal: 'grounding', confidence: 0.70 });
  });
  it('evals.json matching schema (≥3) → ai_eval_quality', () => {
    const src = JSON.stringify([{prompt:'a',expected:'1'},{prompt:'b',expected_output:'2'},{prompt:'c',ideal:'3'}]);
    expect(detectAiPatterns(src, null, 'evals.json')[0]).toMatchObject({ topic_hint: 'ai_eval_quality', signal: 'eval_harness', confidence: 0.75 });
  });
  it('cost: token usage + price computation → ai_cost_engineering', () => {
    const src = 'const cost = usage.inputTokens * 0.000003 + usage.outputTokens * 0.000015;\n';
    expect(detectAiPatterns(src, 'typescript', 'cost.ts')[0]).toMatchObject({ topic_hint: 'ai_cost_engineering', signal: 'cost_engineering', confidence: 0.70 });
  });
});

describe('detectAiPatterns — do NOT detect', () => {
  it('MCP dependency in package.json only (no call-site) → nothing', () =>
    expect(detectAiPatterns('{ "dependencies": { "@modelcontextprotocol/sdk": "^1.0.0" } }', null, 'package.json')).toEqual([]));
  it('grounding class that is an empty stub → nothing', () =>
    expect(detectAiPatterns('class GroundingVerifier {\n  verify() { return true; }\n}\n', 'typescript', 'g.ts')).toEqual([]));
  it('the word "grounding" in a comment → nothing', () =>
    expect(detectAiPatterns('// grounding is important for hallucination\nconst x = 1;\n', 'typescript', 'c.ts')).toEqual([]));
  it('a bare evals.json that is not the schema → nothing', () =>
    expect(detectAiPatterns('{ "eslintConfig": true }', null, 'evals.json')).toEqual([]));
  it('a prompts/ dir file (path only) → nothing', () =>
    expect(detectAiPatterns('export const SYSTEM = "You are helpful";\n', 'typescript', 'prompts/system.ts')).toEqual([]));
  it('plain usage logging without a price computation → nothing', () =>
    expect(detectAiPatterns('logger.info({ usage: resp.usage });\n', 'typescript', 'log.ts')).toEqual([]));
});
