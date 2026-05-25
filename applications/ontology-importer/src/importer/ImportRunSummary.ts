/** @format */
import type { ImportRunCounts } from '@bedrock/shared';

/** One-line human summary of a run. */
export function formatRunSummary(source: string, counts: ImportRunCounts): string {
    return `[ontology-import] source=${source} fetched=${counts.entriesFetched} ` +
        `inserted=${counts.entriesInserted} updated=${counts.entriesUpdated} ` +
        `deactivated=${counts.entriesDeactivated} aliasMerges=${counts.aliasMerges} ` +
        `unresolved=${counts.unresolvedCount} reviewQueued=${counts.reviewQueueAdded}`;
}

/** Flat metric map for Prometheus gauges. */
export function toMetrics(counts: ImportRunCounts): Record<string, number> {
    return {
        entries_fetched: counts.entriesFetched,
        entries_inserted: counts.entriesInserted,
        entries_updated: counts.entriesUpdated,
        entries_deactivated: counts.entriesDeactivated,
        alias_merges: counts.aliasMerges,
        unresolved_count: counts.unresolvedCount,
        review_queue_added: counts.reviewQueueAdded,
    };
}
