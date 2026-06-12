/** @format */
import type { SkillEvidenceEntry } from '@bedrock/shared';
import { retrieveToolEvidenceFiles, enrichLedgerWithEvidence } from './tool-evidence-retrieval.js';
import type { EvidenceRetrievalDeps } from './tool-evidence-retrieval.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const FLOOR = 0.28;

function makeEntry(overrides: Partial<SkillEvidenceEntry> & Pick<SkillEvidenceEntry, 'tool' | 'status'>): SkillEvidenceEntry {
    return {
        evidenceFiles: [],
        evidence: '',
        transferableBridge: '',
        ...overrides,
    };
}

function makeDeps(overrides: {
    querySimilarResults?: Array<{ repoFullName: string; filePath: string; cosine: number | null }>;
    querySimilarError?: Error;
    embedError?: Error;
}): EvidenceRetrievalDeps {
    const store = {
        querySimilar: overrides.querySimilarError
            ? jest.fn().mockRejectedValue(overrides.querySimilarError)
            : jest.fn().mockResolvedValue(overrides.querySimilarResults ?? []),
    };
    const embedder = {
        embed: overrides.embedError
            ? jest.fn().mockRejectedValue(overrides.embedError)
            : jest.fn().mockResolvedValue([0.1, 0.2, 0.3]),
    };
    return { store, embedder, userId: 'user-123' };
}

// ---------------------------------------------------------------------------
// retrieveToolEvidenceFiles
// ---------------------------------------------------------------------------

describe('retrieveToolEvidenceFiles', () => {
    it('returns deduped file paths above the floor, capped at topN (default 3)', async () => {
        const results = [
            { repoFullName: 'Nelson-Lamounier/repo-a', filePath: 'src/index.ts', cosine: 0.85 },
            { repoFullName: 'Nelson-Lamounier/repo-b', filePath: 'lib/helper.ts', cosine: 0.60 },
            { repoFullName: 'Nelson-Lamounier/repo-c', filePath: 'scripts/run.py', cosine: 0.45 },
            { repoFullName: 'Nelson-Lamounier/repo-d', filePath: 'extras/util.ts', cosine: 0.30 },
        ];
        const deps = makeDeps({ querySimilarResults: results });

        const files = await retrieveToolEvidenceFiles('TypeScript', deps);

        expect(files).toEqual([
            'Nelson-Lamounier/repo-a/src/index.ts',
            'Nelson-Lamounier/repo-b/lib/helper.ts',
            'Nelson-Lamounier/repo-c/scripts/run.py',
        ]);
    });

    it('excludes files whose cosine is strictly below the floor', async () => {
        const results = [
            { repoFullName: 'Nelson-Lamounier/repo-a', filePath: 'good.ts', cosine: 0.50 },
            { repoFullName: 'Nelson-Lamounier/repo-b', filePath: 'bad.ts', cosine: 0.10 },
            { repoFullName: 'Nelson-Lamounier/repo-c', filePath: 'noise.ts', cosine: 0.05 },
        ];
        const deps = makeDeps({ querySimilarResults: results });

        const files = await retrieveToolEvidenceFiles('Python', deps, { floor: FLOOR });

        expect(files).toEqual(['Nelson-Lamounier/repo-a/good.ts']);
    });

    it('excludes files whose cosine is null', async () => {
        const results = [
            { repoFullName: 'Nelson-Lamounier/repo-a', filePath: 'ok.ts', cosine: 0.80 },
            { repoFullName: 'Nelson-Lamounier/repo-b', filePath: 'null-cosine.ts', cosine: null },
        ];
        const deps = makeDeps({ querySimilarResults: results });

        const files = await retrieveToolEvidenceFiles('AWS CDK', deps);

        expect(files).toEqual(['Nelson-Lamounier/repo-a/ok.ts']);
    });

    it('deduplicates identical paths (preserving first occurrence order)', async () => {
        const results = [
            { repoFullName: 'Nelson-Lamounier/repo-a', filePath: 'src/a.ts', cosine: 0.90 },
            { repoFullName: 'Nelson-Lamounier/repo-a', filePath: 'src/a.ts', cosine: 0.85 },
            { repoFullName: 'Nelson-Lamounier/repo-b', filePath: 'src/b.ts', cosine: 0.70 },
        ];
        const deps = makeDeps({ querySimilarResults: results });

        const files = await retrieveToolEvidenceFiles('React', deps);

        expect(files).toEqual([
            'Nelson-Lamounier/repo-a/src/a.ts',
            'Nelson-Lamounier/repo-b/src/b.ts',
        ]);
    });

    it('respects a custom topN option', async () => {
        const results = [
            { repoFullName: 'r', filePath: 'a.ts', cosine: 0.90 },
            { repoFullName: 'r', filePath: 'b.ts', cosine: 0.80 },
            { repoFullName: 'r', filePath: 'c.ts', cosine: 0.70 },
            { repoFullName: 'r', filePath: 'd.ts', cosine: 0.60 },
        ];
        const deps = makeDeps({ querySimilarResults: results });

        const files = await retrieveToolEvidenceFiles('Docker', deps, { topN: 2 });

        expect(files).toHaveLength(2);
        expect(files).toEqual(['r/a.ts', 'r/b.ts']);
    });

    it('returns [] when all results are below the floor', async () => {
        const results = [
            { repoFullName: 'r', filePath: 'noise.ts', cosine: 0.05 },
        ];
        const deps = makeDeps({ querySimilarResults: results });

        const files = await retrieveToolEvidenceFiles('Rust', deps, { floor: FLOOR });

        expect(files).toEqual([]);
    });

    it('returns [] and does not throw when the embedder throws (fail-open)', async () => {
        const deps = makeDeps({ embedError: new Error('Bedrock throttle') });

        const files = await retrieveToolEvidenceFiles('GraphQL', deps);

        expect(files).toEqual([]);
    });

    it('returns [] and does not throw when querySimilar throws (fail-open)', async () => {
        const deps = makeDeps({ querySimilarError: new Error('DB connection refused') });

        const files = await retrieveToolEvidenceFiles('Kubernetes', deps);

        expect(files).toEqual([]);
    });

    it('passes the tool string as queryText to querySimilar', async () => {
        const deps = makeDeps({ querySimilarResults: [] });

        await retrieveToolEvidenceFiles('Terraform', deps);

        expect(deps.store.querySimilar).toHaveBeenCalledWith(
            expect.objectContaining({ queryText: 'Terraform', useHybrid: true }),
        );
    });

    it('passes the embedded vector as queryEmbedding to querySimilar', async () => {
        const embedding = [0.1, 0.2, 0.3];
        const deps = makeDeps({ querySimilarResults: [] });
        (deps.embedder.embed as jest.Mock).mockResolvedValue(embedding);

        await retrieveToolEvidenceFiles('Node.js', deps);

        expect(deps.store.querySimilar).toHaveBeenCalledWith(
            expect.objectContaining({ queryEmbedding: embedding }),
        );
    });
});

// ---------------------------------------------------------------------------
// enrichLedgerWithEvidence
// ---------------------------------------------------------------------------

describe('enrichLedgerWithEvidence', () => {
    it('verified entry gets its evidenceFiles enriched with retrieved files (per-tool first)', async () => {
        const entry = makeEntry({
            tool: 'TypeScript',
            status: 'verified',
            evidenceFiles: ['existing/matcher-file.ts'],
        });
        const retrieved = [
            { repoFullName: 'Nelson-Lamounier/repo', filePath: 'src/app.ts', cosine: 0.90 },
        ];
        const deps = makeDeps({ querySimilarResults: retrieved });

        const [enriched] = await enrichLedgerWithEvidence([entry], deps);

        // Per-tool file comes first; existing matcher file follows (deduped)
        expect(enriched!.evidenceFiles).toEqual([
            'Nelson-Lamounier/repo/src/app.ts',
            'existing/matcher-file.ts',
        ]);
        expect(enriched!.status).toBe('verified');
        expect(enriched!.tool).toBe('TypeScript');
    });

    it('transferable entry gets its evidenceFiles enriched', async () => {
        const entry = makeEntry({
            tool: 'GraphQL',
            status: 'transferable',
            evidenceFiles: ['old/rest.ts'],
        });
        const retrieved = [{ repoFullName: 'r', filePath: 'api/gql.ts', cosine: 0.75 }];
        const deps = makeDeps({ querySimilarResults: retrieved });

        const [enriched] = await enrichLedgerWithEvidence([entry], deps);

        expect(enriched!.evidenceFiles).toContain('r/api/gql.ts');
        expect(enriched!.status).toBe('transferable');
    });

    it('GAP entry is NEVER touched — evidenceFiles stay [] even when retrieval returns strong hits', async () => {
        const entry = makeEntry({ tool: 'Rust', status: 'gap' });
        // Store returns a high-cosine match — must be ignored for gap entries
        const retrieved = [{ repoFullName: 'r', filePath: 'rust-project/main.rs', cosine: 0.99 }];
        const deps = makeDeps({ querySimilarResults: retrieved });

        const [gapEntry] = await enrichLedgerWithEvidence([entry], deps);

        expect(gapEntry!.evidenceFiles).toEqual([]);
        expect(gapEntry!.status).toBe('gap');
        // The store should NOT have been queried for a gap entry
        expect(deps.store.querySimilar).not.toHaveBeenCalled();
    });

    it('deduplicates across retrieved + existing matcher files (no duplicates)', async () => {
        const sharedFile = 'Nelson-Lamounier/repo/src/shared.ts';
        const entry = makeEntry({
            tool: 'Python',
            status: 'verified',
            evidenceFiles: [sharedFile],
        });
        const retrieved = [{ repoFullName: 'Nelson-Lamounier/repo', filePath: 'src/shared.ts', cosine: 0.88 }];
        const deps = makeDeps({ querySimilarResults: retrieved });

        const [enriched] = await enrichLedgerWithEvidence([entry], deps);

        expect(enriched!.evidenceFiles.filter((f) => f === sharedFile)).toHaveLength(1);
    });

    it('respects topN cap across the combined set', async () => {
        const entry = makeEntry({
            tool: 'AWS CDK',
            status: 'verified',
            evidenceFiles: ['existing/a.ts', 'existing/b.ts'],
        });
        const retrieved = [
            { repoFullName: 'r', filePath: 'new/x.ts', cosine: 0.95 },
            { repoFullName: 'r', filePath: 'new/y.ts', cosine: 0.85 },
        ];
        const deps = makeDeps({ querySimilarResults: retrieved });

        const [enriched] = await enrichLedgerWithEvidence([entry], deps, { topN: 2 });

        expect(enriched!.evidenceFiles).toHaveLength(2);
        // Per-tool retrieved files come first
        expect(enriched!.evidenceFiles).toEqual(['r/new/x.ts', 'r/new/y.ts']);
    });

    it('returns entry unchanged when retrieval throws (fail-open per entry)', async () => {
        const entry = makeEntry({
            tool: 'Kubernetes',
            status: 'verified',
            evidenceFiles: ['existing/k8s.yaml'],
        });
        const deps = makeDeps({ querySimilarError: new Error('connection refused') });

        const [enriched] = await enrichLedgerWithEvidence([entry], deps);

        expect(enriched).toEqual(entry);
    });

    it('processes all entries in parallel — gap entry untouched, verified enriched', async () => {
        const gapEntry = makeEntry({ tool: 'Elixir', status: 'gap' });
        const verifiedEntry = makeEntry({
            tool: 'TypeScript',
            status: 'verified',
            evidenceFiles: [],
        });
        const retrieved = [{ repoFullName: 'r', filePath: 'app.ts', cosine: 0.80 }];
        const deps = makeDeps({ querySimilarResults: retrieved });

        const result = await enrichLedgerWithEvidence([gapEntry, verifiedEntry], deps);

        const gap = result.find((e) => e.tool === 'Elixir')!;
        const verified = result.find((e) => e.tool === 'TypeScript')!;

        expect(gap.evidenceFiles).toEqual([]);
        expect(gap.status).toBe('gap');
        expect(verified.evidenceFiles).toContain('r/app.ts');
    });

    it('returns empty array when ledger is empty', async () => {
        const deps = makeDeps({ querySimilarResults: [] });

        const result = await enrichLedgerWithEvidence([], deps);

        expect(result).toEqual([]);
    });

    it('preserves all non-evidenceFiles fields on enriched entries', async () => {
        const entry = makeEntry({
            tool: 'Docker',
            status: 'verified',
            evidence: 'Containerised 3 production services',
            transferableBridge: '',
            evidenceFiles: [],
        });
        const retrieved = [{ repoFullName: 'r', filePath: 'Dockerfile', cosine: 0.70 }];
        const deps = makeDeps({ querySimilarResults: retrieved });

        const [enriched] = await enrichLedgerWithEvidence([entry], deps);

        expect(enriched!.tool).toBe('Docker');
        expect(enriched!.evidence).toBe('Containerised 3 production services');
        expect(enriched!.transferableBridge).toBe('');
    });
});
