/** @format */
import { describe, it, expect } from '@jest/globals';
import { formatRunSummary, toMetrics } from './ImportRunSummary.js';
import type { ImportRunCounts } from '@bedrock/shared';

const counts: ImportRunCounts = {
    entriesFetched: 100,
    entriesInserted: 12,
    entriesUpdated: 34,
    entriesDeactivated: 5,
    aliasMerges: 7,
    unresolvedCount: 9,
    reviewQueueAdded: 3,
};

describe('ImportRunSummary', () => {
    it('formatRunSummary contains the source name and each numeric value', () => {
        const line = formatRunSummary('npm_top_5k', counts);
        expect(line).toContain('npm_top_5k');
        expect(line).toContain('fetched=100');
        expect(line).toContain('inserted=12');
        expect(line).toContain('updated=34');
        expect(line).toContain('deactivated=5');
        expect(line).toContain('aliasMerges=7');
        expect(line).toContain('unresolved=9');
        expect(line).toContain('reviewQueued=3');
    });

    it('toMetrics has all 7 keys with matching values', () => {
        const m = toMetrics(counts);
        expect(Object.keys(m)).toHaveLength(7);
        expect(m).toEqual({
            entries_fetched: 100,
            entries_inserted: 12,
            entries_updated: 34,
            entries_deactivated: 5,
            alias_merges: 7,
            unresolved_count: 9,
            review_queue_added: 3,
        });
    });
});
