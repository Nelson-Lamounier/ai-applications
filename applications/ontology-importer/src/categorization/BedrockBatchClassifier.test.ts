/** @format */
import { describe, it, expect } from '@jest/globals';
import { buildJsonlRecords, parseModelOutput, MODEL_ID_DEFAULT } from './BedrockBatchClassifier.js';
import type { RawImportEntry } from '@bedrock/shared';

const E = (o: Partial<RawImportEntry>): RawImportEntry =>
    ({ source_identifier: '', proposed_canonical_name: '', proposed_display_name: '', source_metadata: {}, ...o });

describe('buildJsonlRecords', () => {
    it('pools entries into alphanumeric recordIds with a Bedrock Messages modelInput', () => {
        const { records, recordMap } = buildJsonlRecords([
            { entry: E({ source_identifier: 'fastify', description: 'web framework' }), ecosystem: 'npm' },
            { entry: E({ source_identifier: 'org.springframework:spring-core' }), ecosystem: 'maven' },
        ]);
        expect(records).toHaveLength(2);
        // recordId is purely alphanumeric (Bedrock constraint ^[a-zA-Z0-9]{1,64}$)
        for (const r of records) expect(r.recordId).toMatch(/^[a-zA-Z0-9]{1,64}$/);
        const mi = records[0].modelInput as Record<string, unknown>;
        expect(mi.anthropic_version).toBe('bedrock-2023-05-31');
        expect(mi.max_tokens).toBe(256);
        expect((mi.tools as Array<{ name: string }>)[0].name).toBe('classify_package');
        expect(mi.tool_choice).toEqual({ type: 'tool', name: 'classify_package' });
        // no prompt caching in batch
        expect(JSON.stringify(mi)).not.toContain('cache_control');
        // recordMap resolves the second record back to its maven identifier
        const r1 = records[1].recordId;
        expect(recordMap[r1]).toEqual({ ecosystem: 'maven', identifier: 'org.springframework:spring-core' });
    });
});

describe('parseModelOutput', () => {
    it('extracts the classify_package tool_use from modelOutput', () => {
        const out = parseModelOutput({
            recordId: 'r0000001',
            modelOutput: { content: [{ type: 'tool_use', name: 'classify_package', input: { decision: 'yes', category: 'framework_web', reasoning: 'web fw' } }] },
        });
        expect(out).toEqual({ recordId: 'r0000001', decision: 'yes', category: 'framework_web', reasoning: 'web fw' });
    });
    it('defaults to maybe/null when no tool_use', () => {
        const out = parseModelOutput({ recordId: 'r0000002', modelOutput: { content: [{ type: 'text' }] } });
        expect(out).toMatchObject({ recordId: 'r0000002', decision: 'maybe', category: null });
    });
    it('defaults to maybe/null when modelOutput missing (errored record)', () => {
        expect(parseModelOutput({ recordId: 'r3' }).decision).toBe('maybe');
    });
});
