/** @format */
import { assignSkillsToChunks } from './assignSkillsToChunks.js';
import type { FileEnrichUnit } from './groupChunksByFile.js';
import type { RawChunk } from '../types.js';

function chunk(chunkIndex: number, content: string): RawChunk {
    return { filePath: 'f.ts', chunkIndex, content, totalChunks: 0 };
}

const noResolver = (): boolean => false;

describe('assignSkillsToChunks', () => {
    it('attaches a file skill only to the chunk that evidences it (precision guard)', () => {
        const unit: FileEnrichUnit = {
            filePath: 'f.ts',
            chunks: [chunk(0, 'sets up kubernetes networking with calico'), chunk(1, 'renders a react component')],
            text: '',
        };
        const out = assignSkillsToChunks(unit, ['kubernetes networking', 'react development'], noResolver);
        expect(out.find((a) => a.chunkIndex === 0)?.skills).toEqual(['kubernetes networking']);
        // chunk 1 must NOT inherit the kubernetes skill from elsewhere in the file
        expect(out.find((a) => a.chunkIndex === 1)?.skills).not.toContain('kubernetes networking');
    });

    it('per-chunk skills are always a subset of the unit skills', () => {
        const unit: FileEnrichUnit = { filePath: 'f.ts', chunks: [chunk(0, 'terraform plan apply')], text: '' };
        const out = assignSkillsToChunks(unit, ['terraform'], noResolver);
        expect(out[0].skills.every((s) => ['terraform'].includes(s))).toBe(true);
    });

    it('drops a unit skill that no chunk evidences', () => {
        const unit: FileEnrichUnit = { filePath: 'f.ts', chunks: [chunk(0, 'plain prose, no signal')], text: '' };
        const out = assignSkillsToChunks(unit, ['observability'], noResolver);
        expect(out[0].skills).toEqual([]); // observability appears nowhere -> dropped
    });

    it('uses the injected resolver evidence for paraphrase (no surface match)', () => {
        const unit: FileEnrichUnit = { filePath: 'f.ts', chunks: [chunk(0, 'auto scaling group configuration')], text: '' };
        // surface miss, but resolver says the chunk embeds near "aws auto scaling"
        const resolver = (content: string, skill: string): boolean =>
            content.includes('auto scaling') && skill === 'aws auto scaling';
        const out = assignSkillsToChunks(unit, ['aws auto scaling'], resolver);
        expect(out[0].skills).toEqual(['aws auto scaling']);
    });
});
