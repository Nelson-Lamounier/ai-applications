/** @format */
import { buildEnrichRecords, sanitizeJobName, type BatchEnrichItem } from './BedrockBatchEnrich.js';
import { buildExtractionBody } from '../rds/implementations/extractionBody.js';

function item(id: string, filePath: string, content: string): BatchEnrichItem {
    return { id, filePath, content };
}

describe('buildEnrichRecords', () => {
    it('emits one record per item with a recordId→id map (granularity-agnostic)', () => {
        const { records, recordToId } = buildEnrichRecords([
            item('a.ts::0', 'a.ts', 'x'),
            item('a.ts::1', 'a.ts', 'y'),   // same file, distinct chunk ids (per-chunk lever)
        ]);
        expect(records).toHaveLength(2);
        expect(recordToId[records[0].recordId]).toBe('a.ts::0');
        expect(recordToId[records[1].recordId]).toBe('a.ts::1');
        expect(records[0].recordId).not.toBe(records[1].recordId);
    });

    it('uses the SHARED extraction body (batch == inline, cost-only)', () => {
        const { records } = buildEnrichRecords([item('a.ts::0', 'a.ts', 'hello')]);
        expect(records[0].modelInput).toEqual(buildExtractionBody('a.ts', 'hello'));
    });
});

describe('sanitizeJobName', () => {
    it('strips underscores/spaces to the Bedrock jobName charset and caps at 63', () => {
        expect(sanitizeJobName('enrich_run 1/2')).toBe('enrich-run-1-2');
        expect(sanitizeJobName('x'.repeat(80)).length).toBe(63);
    });
});
