/** @format */
import { describe, it, expect } from '@jest/globals';
import { buildJsonlRecords, parseModelOutput, sanitizeJobName, MODEL_ID_DEFAULT } from './BedrockBatchClassifier.js';
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
    it('coerces out-of-set category to null (LLM ignored input_schema enum hint)', () => {
        // Live failure case: Claude returned `category: "networking"` which is NOT in
        // the 30-set (only `cloud_networking` is). DB CHECK constraint would reject the
        // insert. parseModelOutput must defang this BEFORE the router sees it.
        const out = parseModelOutput({
            recordId: 'r4',
            modelOutput: { content: [{ type: 'tool_use', name: 'classify_package', input: { decision: 'yes', category: 'networking', reasoning: 'router' } }] },
        });
        expect(out.decision).toBe('yes');
        expect(out.category).toBeNull();   // ← invalid → null, downstream routes to review_queue
        expect(out.reasoning).toBe('router');
    });
    it('keeps valid in-set category', () => {
        const out = parseModelOutput({
            recordId: 'r5',
            modelOutput: { content: [{ type: 'tool_use', name: 'classify_package', input: { decision: 'yes', category: 'cloud_networking', reasoning: 'ok' } }] },
        });
        expect(out.category).toBe('cloud_networking');
    });
});

describe('sanitizeJobName', () => {
    const PATTERN = /^[a-zA-Z0-9]{1,63}(-*[a-zA-Z0-9+\-.]){0,63}$/;

    it('replaces underscores with dashes (the live failure case)', () => {
        const out = sanitizeJobName('ontology-importer-import_1779776543');
        expect(out).toBe('ontology-importer-import-1779776543');
        expect(out).toMatch(PATTERN);
    });
    it('coerces any non [a-zA-Z0-9+\\-.] char to dash', () => {
        expect(sanitizeJobName('a b/c:d_e@f')).toBe('a-b-c-d-e-f');
    });
    it('caps length at 63 chars', () => {
        const long = 'ontology-importer-' + 'a'.repeat(100);
        const out = sanitizeJobName(long);
        expect(out.length).toBe(63);
        expect(out).toMatch(PATTERN);
    });
    it('passes already-valid input unchanged', () => {
        expect(sanitizeJobName('ontology-importer-import-1779776543')).toBe('ontology-importer-import-1779776543');
    });
});
