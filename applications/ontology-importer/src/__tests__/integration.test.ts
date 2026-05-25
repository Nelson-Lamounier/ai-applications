/** @format */
import { describe, it, expect } from '@jest/globals';
import { OntologyImporter } from '../importer/OntologyImporter.js';
import type { OntologyWritePort, ImportSourcePort } from '../importer/OntologyImporter.js';
import { Categorizer } from '../categorization/Categorizer.js';
import { FakeSource } from '../sources/FakeSource.js';
import { parseBatchResult, buildBatchRequests } from '../categorization/LlmBatchClassifier.js';

/** In-memory OntologyWritePort backed by JS Maps so runs are idempotent. */
class InMemoryOntologyWrite implements OntologyWritePort {
    readonly techs = new Map<string, { id: string; curationLevel: string }>();
    readonly aliases = new Map<string, string>();
    private n = 0;

    async findByCanonical(canonical: string): Promise<{ id: string; curationLevel: string } | null> {
        return this.techs.get(canonical) ?? null;
    }
    async insertAutoImported(canonical: string): Promise<string> {
        const id = `tech-${this.n++}`;
        this.techs.set(canonical, { id, curationLevel: 'auto_imported' });
        return id;
    }
    async bumpPopularity(): Promise<void> {
        // no-op
    }
    async loadAliasMap(): Promise<Map<string, string>> {
        return new Map(this.aliases);
    }
    async insertAliases(technologyId: string, aliases: string[]): Promise<number> {
        let inserted = 0;
        for (const a of aliases) {
            if (!this.aliases.has(a)) {
                this.aliases.set(a, technologyId);
                inserted++;
            }
        }
        return inserted;
    }
}

/** In-memory ImportSourcePort. */
class InMemoryImportSources implements ImportSourcePort {
    readonly seen = new Map<string, { source: string; sourceIdentifier: string }>();
    async upsertSeen(technologyId: string, source: string, sourceIdentifier: string): Promise<void> {
        this.seen.set(`${source}:${sourceIdentifier}`, { source, sourceIdentifier });
    }
    async incrementMissesOlderThan(): Promise<number> {
        return 0;
    }
}

describe('ontology-importer in-process integration', () => {
    it('first run inserts categorized entries and is idempotent on a second run', async () => {
        const ontology = new InMemoryOntologyWrite();
        const importSources = new InMemoryImportSources();
        const importer = new OntologyImporter(new Categorizer(), ontology, importSources);
        const source = new FakeSource();

        // --- First run ---
        const first = await importer.run(source, new Date());

        expect(first.counts.entriesInserted).toBe(2); // @nestjs/core + prisma
        expect(first.counts.entriesUpdated).toBe(0);
        expect(first.unresolved.map((u) => u.source_identifier)).toContain('totally-unknown-xyz');
        expect(first.unresolved.map((u) => u.source_identifier)).not.toContain('@types/node');
        expect(ontology.aliases.size).toBeGreaterThan(0);

        // --- Second run (same source + same in-memory state) ---
        const second = await importer.run(source, new Date());

        expect(second.counts.entriesInserted).toBe(0);
        expect(second.counts.entriesUpdated).toBe(2); // both now exist → bump path
    });
});

/** Build a batch message carrying a `classify_package` tool_use block. */
function toolUseMessage(decision: 'yes' | 'no' | 'maybe', category: string | null, reasoning: string) {
    return { content: [{ type: 'tool_use', name: 'classify_package', input: { decision, category, reasoning } }] };
}

describe('ontology-importer LLM batch-routing smoke', () => {
    it('routes parsed batch results to insert/skip/review buckets end-to-end', async () => {
        // --- Stage 1: importer run produces the unresolved set the follow-up consumes. ---
        const ontology = new InMemoryOntologyWrite();
        const importSources = new InMemoryImportSources();
        const importer = new OntologyImporter(new Categorizer(), ontology, importSources);
        const source = new FakeSource();

        const { counts, unresolved } = await importer.run(source, new Date());

        expect(counts.entriesInserted).toBe(2); // @nestjs/core + prisma
        expect(counts.entriesUpdated).toBe(0);
        expect(unresolved.map((u) => u.source_identifier)).toContain('totally-unknown-xyz');
        expect(unresolved.length).toBeGreaterThanOrEqual(1);

        // --- Stage 1b: buildBatchRequests emits one request per unresolved entry. ---
        const requests = buildBatchRequests(unresolved, 'npm');
        expect(requests).toHaveLength(unresolved.length);
        for (const req of requests) {
            expect(req.custom_id.startsWith('npm:')).toBe(true);
        }

        // --- Stage 2: simulate the follow-up routing without the real SDK. ---
        // Three stubbed message shapes → one of each decision outcome.
        const fakeMessages = [
            toolUseMessage('yes', 'database_relational', 'is a database'), // → inserted
            toolUseMessage('no', null, 'not a technology'), // → skipped
            { content: [{ type: 'text', text: 'no tool call here' }] }, // no tool_use → maybe/null → review
        ];

        const inserted: string[] = [];
        const skipped: string[] = [];
        const reviewQueue: string[] = [];

        for (let i = 0; i < fakeMessages.length; i++) {
            const customId = `npm:entry-${i}`;
            const { decision, category } = parseBatchResult(customId, fakeMessages[i]);
            if (decision === 'yes' && category) {
                inserted.push(customId); // mirrors ontology.insertAutoImported
            } else if (decision === 'no') {
                skipped.push(customId); // mirrors skipped.add
            } else {
                reviewQueue.push(customId); // mirrors reviewQueue.add (maybe/null)
            }
        }

        // Exactly one landed in each bucket — validates parse + routing together.
        expect(inserted).toHaveLength(1);
        expect(skipped).toHaveLength(1);
        expect(reviewQueue).toHaveLength(1);
    });
});
