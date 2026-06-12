/**
 * @format
 * Tool Evidence Retrieval — per-tool targeted pgvector query for the Skill Evidence Ledger.
 *
 * After the deterministic ledger is built by buildSkillEvidenceLedger, this
 * module ENRICHES each verified/transferable entry's evidenceFiles by running
 * a dedicated pgvector query for that specific tool.
 *
 * GAP entries are NEVER touched — their evidenceFiles remain [] (honesty invariant).
 * All retrieval errors are fail-open — the entry is returned unchanged.
 */

import type { SkillEvidenceEntry } from '@bedrock/shared';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface EvidenceRetrievalDeps {
    readonly store: {
        querySimilar(p: {
            userId: string;
            queryEmbedding: number[];
            queryText: string;
            useHybrid: boolean;
            limit: number;
        }): Promise<Array<{ repoFullName: string; filePath: string; cosine: number | null }>>;
    };
    readonly embedder: { embed(text: string): Promise<number[]> };
    readonly userId: string;
}

export interface EvidenceRetrievalOpts {
    /** Maximum files to keep per entry (default: 3). */
    readonly topN?: number;
    /** Minimum cosine score to include a result (default: FLOOR env var or 0.28). */
    readonly floor?: number;
    /** How many rows to fetch from the DB before scoring/capping (default: 12). */
    readonly limit?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default cosine floor — a notch above the 0.20 noise-floor used by research
 * queries so only files with real topical overlap are attached as proof.
 * Override via LEDGER_EVIDENCE_FLOOR env var.
 */
const DEFAULT_FLOOR = Number.parseFloat(process.env['LEDGER_EVIDENCE_FLOOR'] ?? '0.28');

// ---------------------------------------------------------------------------
// retrieveToolEvidenceFiles
// ---------------------------------------------------------------------------

/**
 * Targeted retrieval for ONE tool → its best KB file paths.
 *
 * Steps:
 *  1. Embed the tool name via Titan.
 *  2. querySimilar (hybrid, limit rows from the DB).
 *  3. Filter by cosine >= floor (null cosine treated as below floor).
 *  4. Map to `${repoFullName}/${filePath}` (canonical path).
 *  5. Dedupe preserving order, take topN.
 *
 * Fail-open: any error → [].
 */
export async function retrieveToolEvidenceFiles(
    tool: string,
    deps: EvidenceRetrievalDeps,
    opts?: EvidenceRetrievalOpts,
): Promise<string[]> {
    const floor = opts?.floor ?? DEFAULT_FLOOR;
    const topN = opts?.topN ?? 3;
    const limit = opts?.limit ?? 12;

    try {
        const queryEmbedding = await deps.embedder.embed(tool);
        const rows = await deps.store.querySimilar({
            userId: deps.userId,
            queryEmbedding,
            queryText: tool,
            useHybrid: true,
            limit,
        });

        const seen = new Set<string>();
        const paths: string[] = [];

        for (const row of rows) {
            if (row.cosine == null || row.cosine < floor) continue;
            const path = `${row.repoFullName}/${row.filePath}`;
            if (seen.has(path)) continue;
            seen.add(path);
            paths.push(path);
            if (paths.length >= topN) break;
        }

        return paths;
    } catch {
        return [];
    }
}

// ---------------------------------------------------------------------------
// enrichLedgerWithEvidence
// ---------------------------------------------------------------------------

/**
 * Enrich a Skill Evidence Ledger with per-tool targeted retrieval.
 *
 * Rules:
 *  - GAP entries are returned UNCHANGED (evidenceFiles stay []).
 *  - verified/transferable: UNION (retrieved files ++ matcher files), deduped,
 *    per-tool retrieved files placed first, capped at topN.
 *  - Fail-open per entry: any retrieval error → original entry returned.
 *  - All entries are processed concurrently (Promise.all).
 */
export async function enrichLedgerWithEvidence(
    ledger: SkillEvidenceEntry[],
    deps: EvidenceRetrievalDeps,
    opts?: EvidenceRetrievalOpts,
): Promise<SkillEvidenceEntry[]> {
    const topN = opts?.topN ?? 3;

    return Promise.all(
        ledger.map(async (entry) => {
            // Honesty invariant: gap entries never get files.
            if (entry.status === 'gap') {
                return entry;
            }

            try {
                const retrieved = await retrieveToolEvidenceFiles(entry.tool, deps, opts);

                // Union: per-tool retrieval first, then existing matcher files.
                const seen = new Set<string>();
                const merged: string[] = [];

                for (const f of [...retrieved, ...entry.evidenceFiles]) {
                    if (seen.has(f)) continue;
                    seen.add(f);
                    merged.push(f);
                    if (merged.length >= topN) break;
                }

                return { ...entry, evidenceFiles: merged };
            } catch {
                // Fail-open: return original entry on any unexpected error.
                return entry;
            }
        }),
    );
}
