/** @format */
import { describe, it, expect } from '@jest/globals';
import { buildBatchRequests, parseBatchResult, MODEL } from './LlmBatchClassifier.js';
import type { RawImportEntry } from '@bedrock/shared';

const E = (o: Partial<RawImportEntry>): RawImportEntry =>
  ({ source_identifier: '', proposed_canonical_name: '', proposed_display_name: '', source_metadata: {}, ...o });

describe('buildBatchRequests', () => {
  it('one request per entry, Haiku, cached system + classify_package tool', () => {
    const reqs = buildBatchRequests([E({ source_identifier: 'fastify', proposed_canonical_name: 'fastify', description: 'web framework' })], 'npm');
    expect(reqs).toHaveLength(1);
    const p = reqs[0].params;
    expect(p.model).toBe(MODEL);
    expect(p.tools?.[0]?.name).toBe('classify_package');
    expect(JSON.stringify(p.system)).toContain('cache_control');
    expect(reqs[0].custom_id).toContain('fastify');
  });
});

describe('parseBatchResult', () => {
  it('extracts the classify_package tool_use input', () => {
    const msg = { content: [{ type: 'tool_use', name: 'classify_package', input: { decision: 'yes', category: 'framework_web', reasoning: 'web fw' } }] };
    expect(parseBatchResult('npm:fastify', msg as never)).toEqual({ decision: 'yes', category: 'framework_web', reasoning: 'web fw' });
  });
  it('defaults to maybe/null when no tool_use', () => {
    expect(parseBatchResult('x', { content: [{ type: 'text', text: 'hi' }] } as never)).toMatchObject({ decision: 'maybe', category: null });
  });
});
