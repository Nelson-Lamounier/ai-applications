/** @format */
import { buildEnrichRecords, sanitizeJobName } from './BedrockBatchEnrich.js';
import { buildExtractionBody } from '../rds/implementations/extractionBody.js';
import type { FileEnrichUnit } from '../rds/enrichment/groupChunksByFile.js';

function unit(filePath: string, text: string): FileEnrichUnit {
    return { filePath, text, chunks: [{ filePath, chunkIndex: 0, content: text, totalChunks: 1 }] };
}

describe('buildEnrichRecords', () => {
    it('emits one record per file unit with a recordId→file map', () => {
        const { records, recordToFile } = buildEnrichRecords([unit('a.ts', 'x'), unit('b.ts', 'y')]);
        expect(records).toHaveLength(2);
        expect(recordToFile[records[0].recordId]).toBe('a.ts');
        expect(recordToFile[records[1].recordId]).toBe('b.ts');
        expect(records[0].recordId).not.toBe(records[1].recordId);
    });

    it('uses the SHARED extraction body (batch == inline, cost-only)', () => {
        const { records } = buildEnrichRecords([unit('a.ts', 'hello')]);
        expect(records[0].modelInput).toEqual(buildExtractionBody('a.ts', 'hello'));
    });
});

describe('sanitizeJobName', () => {
    it('strips underscores/spaces to the Bedrock jobName charset and caps at 63', () => {
        expect(sanitizeJobName('enrich_run 1/2')).toBe('enrich-run-1-2');
        expect(sanitizeJobName('x'.repeat(80)).length).toBe(63);
    });
});
