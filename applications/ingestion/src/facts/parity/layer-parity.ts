/** @format */

/**
 * Per-layer evidence parity for the `UNIFIED_INGESTION` shadow gate (spec
 * P1). Distinct from `ParityReporter.ts`'s `computeParity`, which is the
 * decommissioned L1-vs-LLM machinery behind the legacy
 * `technology_parity_runs` table — this compares the legacy two-job path's
 * persisted `technology_evidence` rows against the unified job's
 * in-memory-computed rows, grouped by `source_layer`, and is written to the
 * new `unified_parity_runs` table (migration 122).
 */

const EXAMPLE_CAP = 20;

export interface EvidenceKey {
    readonly sourceLayer: string;
    readonly canonicalId: string;
    readonly filePath:    string | null;
}

export interface LayerParity {
    readonly sourceLayer:         string;
    readonly legacyCount:         number;
    readonly unifiedCount:        number;
    readonly intersectionCount:   number;
    readonly legacyOnlyExamples:  string[];
    readonly unifiedOnlyExamples: string[];
}

/** The comparable key for one evidence row within a layer. */
function comparableKey(item: EvidenceKey): string {
    return `${item.canonicalId} ${item.filePath ?? ''}`;
}

/** Groups evidence keys by `sourceLayer`, deduping within each layer. */
function groupByLayer(items: EvidenceKey[]): Map<string, Set<string>> {
    const byLayer = new Map<string, Set<string>>();
    for (const item of items) {
        let keys = byLayer.get(item.sourceLayer);
        if (!keys) {
            keys = new Set<string>();
            byLayer.set(item.sourceLayer, keys);
        }
        keys.add(comparableKey(item));
    }
    return byLayer;
}

/**
 * Compares legacy (persisted, two-job path) evidence keys against unified
 * (in-memory, single-job path) evidence keys, per `sourceLayer`. A layer
 * present on only one side still produces a row, with the other side's
 * counts at 0. Example lists are capped at 20 entries each.
 */
export function computeLayerParity(legacy: EvidenceKey[], unified: EvidenceKey[]): LayerParity[] {
    const legacyByLayer  = groupByLayer(legacy);
    const unifiedByLayer = groupByLayer(unified);

    const layers = new Set<string>([...legacyByLayer.keys(), ...unifiedByLayer.keys()]);

    const results: LayerParity[] = [];
    for (const sourceLayer of layers) {
        const legacyKeys  = legacyByLayer.get(sourceLayer)  ?? new Set<string>();
        const unifiedKeys = unifiedByLayer.get(sourceLayer) ?? new Set<string>();

        let intersectionCount = 0;
        const legacyOnlyExamples: string[] = [];
        for (const k of legacyKeys) {
            if (unifiedKeys.has(k)) intersectionCount++;
            else legacyOnlyExamples.push(k);
        }

        const unifiedOnlyExamples: string[] = [];
        for (const k of unifiedKeys) {
            if (!legacyKeys.has(k)) unifiedOnlyExamples.push(k);
        }

        results.push({
            sourceLayer,
            legacyCount:        legacyKeys.size,
            unifiedCount:       unifiedKeys.size,
            intersectionCount,
            legacyOnlyExamples:  legacyOnlyExamples.slice(0, EXAMPLE_CAP),
            unifiedOnlyExamples: unifiedOnlyExamples.slice(0, EXAMPLE_CAP),
        });
    }

    return results;
}
