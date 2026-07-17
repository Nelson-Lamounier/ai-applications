/** @format */
import { describe, it, expect } from '@jest/globals';

import { SystemTourSchema } from '../system-tour-types.js';

const validArchitecture = {
    diagramFormat: 'mermaid' as const,
    diagramSource: 'graph LR; A-->B',
    nodes: [{ id: 'A', label: 'API', kind: 'backend' as const }],
    edges: [{ from: 'A', to: 'B' }],
};

const validTour = {
    area: 'Ingestion pipeline',
    context: 'GitHub repos are crawled incrementally; the constraint was API rate limits.',
    keyDecisions: [
        { decision: 'Used a commit watermark', rationale: 'Avoids re-fetching every blob on resync.' },
    ],
    tradeoffs: [
        { tension: 'Freshness vs API budget', chosenPath: 'Poll on a schedule', cost: 'Up to N minutes of staleness.' },
    ],
    systemMap: validArchitecture,
    outcomes: ['Cut resync cost by ~60%'],
    whatIdChange: ['Add per-repo backoff'],
};

describe('SystemTourSchema', () => {
    it('parses a valid payload', () => {
        const parsed = SystemTourSchema.safeParse(validTour);
        expect(parsed.success).toBe(true);
    });

    it('rejects an unknown key (.strict)', () => {
        const parsed = SystemTourSchema.safeParse({ ...validTour, bogus: 'nope' });
        expect(parsed.success).toBe(false);
    });

    it('accepts whatIdChange: []', () => {
        const parsed = SystemTourSchema.safeParse({ ...validTour, whatIdChange: [] });
        expect(parsed.success).toBe(true);
    });

    it('requires keyDecisions to have at least one entry', () => {
        const parsed = SystemTourSchema.safeParse({ ...validTour, keyDecisions: [] });
        expect(parsed.success).toBe(false);
    });

    it('reuses ArchitectureSchema for systemMap (rejects an unknown systemMap key)', () => {
        const parsed = SystemTourSchema.safeParse({
            ...validTour,
            systemMap: { ...validArchitecture, bogus: 'x' },
        });
        expect(parsed.success).toBe(false);
    });
});
