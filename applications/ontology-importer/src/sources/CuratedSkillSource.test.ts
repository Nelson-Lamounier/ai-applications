/** @format */
import { describe, it, expect, beforeAll } from '@jest/globals';
import { writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CuratedSkillSource } from './CuratedSkillSource.js';
import type { RawImportEntry } from '@bedrock/shared';

async function collect(src: CuratedSkillSource): Promise<RawImportEntry[]> {
    const out: RawImportEntry[] = [];
    for await (const e of src.fetch()) out.push(e);
    return out;
}

describe('CuratedSkillSource', () => {
    let dataPath: string;

    beforeAll(async () => {
        const dir = await mkdtemp(join(tmpdir(), 'curated-'));
        dataPath = join(dir, 'skills.json');
        await writeFile(dataPath, JSON.stringify({
            licence: 'curated',
            skills: [
                { canonical: 'REST API Design', display: 'REST API Design', category: 'api', aliases: ['REST API', 'restful api'] },
                { canonical: '  ', category: 'other' }, // blank canonical → skipped
            ],
        }));
    });

    it('lowercases the canonical, carries aliases + category in metadata', async () => {
        const [entry] = await collect(new CuratedSkillSource(dataPath));
        expect(entry.proposed_canonical_name).toBe('rest api design');
        expect(entry.proposed_display_name).toBe('REST API Design');
        expect(entry.keywords).toEqual(['rest api', 'restful api']); // lowercased
        expect((entry.source_metadata as { category: string }).category).toBe('api');
    });

    it('skips blank-canonical rows', async () => {
        expect(await collect(new CuratedSkillSource(dataPath))).toHaveLength(1);
    });
    // The real shipped data file is parsed + verified by the local extract runner
    // (run-skill-extract.ts), which jest cannot exercise here because the jest
    // tsconfig forbids import.meta. The temp-file cases above cover the parsing.
});
