/** @format */
import { describe, it, expect, jest } from '@jest/globals';
import { importSource, type SkillWriteOps } from './run-skill-import.js';
import type { SkillSource, RawImportEntry } from './sources/SkillSource.js';
import type { ImportRunCounts } from '@bedrock/shared';

function emptyCounts(): ImportRunCounts {
    return { entriesFetched: 0, entriesInserted: 0, entriesUpdated: 0, entriesDeactivated: 0, aliasMerges: 0, unresolvedCount: 0, reviewQueueAdded: 0 };
}

function source(name: string, licence: string, entries: RawImportEntry[]): SkillSource {
    return { name, licence, async *fetch() { for (const e of entries) yield e; } };
}

function entry(canonical: string, category: string, aliases: string[]): RawImportEntry {
    return { source_identifier: canonical, proposed_canonical_name: canonical, proposed_display_name: canonical, keywords: aliases, source_metadata: { category, aliases } };
}

/** Fake write ops; `curatedFor` forces a curated-collision skip for given canonicals. */
function fakeWrite(curatedFor: string[] = []): SkillWriteOps & { inserted: string[]; aliasCalls: Array<{ id: string; aliases: readonly string[] }> } {
    const inserted: string[] = [];
    const aliasCalls: Array<{ id: string; aliases: readonly string[] }> = [];
    return {
        inserted, aliasCalls,
        insertAutoImported: jest.fn(async (canonical: string) => {
            const curatedSkip = curatedFor.includes(canonical);
            if (!curatedSkip) inserted.push(canonical);
            return { id: `id-${canonical}`, curatedSkip };
        }),
        insertAliases: jest.fn(async (id: string, aliases: readonly string[]) => { aliasCalls.push({ id, aliases }); return aliases.length; }),
    } as SkillWriteOps & { inserted: string[]; aliasCalls: Array<{ id: string; aliases: readonly string[] }> };
}

describe('importSource', () => {
    it('inserts each entry + its aliases, tallying counts', async () => {
        const w = fakeWrite();
        const c = emptyCounts();
        await importSource(source('curated', 'curated', [entry('rest api design', 'api', ['rest api'])]), w, false, c);
        expect(w.inserted).toEqual(['rest api design']);
        expect(c.entriesFetched).toBe(1);
        expect(c.entriesInserted).toBe(1);
        expect(c.aliasMerges).toBe(1);
    });

    it('DRY_RUN counts but writes nothing', async () => {
        const w = fakeWrite();
        const c = emptyCounts();
        await importSource(source('curated', 'curated', [entry('observability', 'observability', [])]), w, true, c);
        expect(w.inserted).toEqual([]);
        expect(w.insertAutoImported).not.toHaveBeenCalled();
        expect(c.entriesInserted).toBe(1); // counted
    });

    it('rejects an off-allowlist licence — writes nothing', async () => {
        const w = fakeWrite();
        const c = emptyCounts();
        await importSource(source('bad', 'proprietary', [entry('x', 'other', [])]), w, false, c);
        expect(w.insertAutoImported).not.toHaveBeenCalled();
        expect(c.entriesFetched).toBe(0);
    });

    it('on a curated collision, attaches name+aliases as aliases, does NOT count an insert (FR-008)', async () => {
        const w = fakeWrite(['rest api design']);
        const c = emptyCounts();
        await importSource(source('curated', 'curated', [entry('rest api design', 'api', ['rest api'])]), w, false, c);
        expect(w.inserted).toEqual([]);                 // not overwritten
        expect(c.entriesInserted).toBe(0);
        expect(w.aliasCalls[0].aliases).toEqual(['rest api design', 'rest api']); // name + aliases attached
    });

    it('derives the licence from the source, not the entry', async () => {
        const w = fakeWrite();
        const c = emptyCounts();
        await importSource(source('technology_ontology', 'derived', [entry('aws cdk', 'infrastructure', ['aws_cdk'])]), w, false, c);
        expect(w.insertAutoImported).toHaveBeenCalledWith('aws cdk', 'aws cdk', 'infrastructure', 'technology_ontology', 'derived', null);
    });
});
