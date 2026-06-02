/** @format */
import { describe, it, expect } from '@jest/globals';

import {
    buildSystemTourSystemPrompt,
    parseSystemTourResponse,
    SYSTEM_TOUR_TOOL,
} from './system-tour-agent.js';
import type { CaseStudy } from './case-study-types.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const architecture: CaseStudy['architecture'] = {
    diagramFormat: 'mermaid',
    diagramSource: 'graph LR; A-->B',
    nodes: [{ id: 'A', label: 'API', kind: 'backend' }],
    edges: [{ from: 'A', to: 'B' }],
};

const baseCaseStudy: CaseStudy = {
    tagline: 'A grounded multi-repo portfolio engine.',
    pitch: 'I built a pipeline that turns repos into case studies.',
    stack: [],
    decisions: [],
    highlights: [],
    challenges: [],
    depthMarkers: {
        hasTests: true,
        testCoverageSignal: 'strong',
        hasCi: true,
        ciMaturity: 'deploys_to_prod',
        documentationDensity: 'docs_dir',
        hasDeploymentEvidence: true,
        refactorCount: 3,
    },
    architecture,
    resumeBullets: [{ angle: 'backend', bullets: ['Built X'] }],
};

/** A well-formed forced-tool payload (what the model would emit). */
const validTourPayload = {
    area: 'Ingestion pipeline',
    context: 'Repos crawled incrementally under API rate limits.',
    keyDecisions: [{ decision: 'Commit watermark', rationale: 'Avoids re-fetching blobs.' }],
    tradeoffs: [{ tension: 'Freshness vs budget', chosenPath: 'Scheduled poll', cost: 'Staleness.' }],
    systemMap: architecture,
    outcomes: ['Cut resync cost ~60%'],
    whatIdChange: [],
};

// ─── (a) parse + validate ────────────────────────────────────────────────────

describe('parseSystemTourResponse', () => {
    it('parses + validates a forced-tool JSON response into a SystemTour', () => {
        const tour = parseSystemTourResponse(JSON.stringify(validTourPayload));
        expect(tour.area).toBe('Ingestion pipeline');
        expect(tour.systemMap).toEqual(architecture);
        expect(tour.whatIdChange).toEqual([]);
    });

    // ─── (b) fail-fast ───────────────────────────────────────────────────────
    it('throws on an extra (unknown) key — fail-fast', () => {
        const bad = JSON.stringify({ ...validTourPayload, bogus: 'nope' });
        expect(() => parseSystemTourResponse(bad)).toThrow(/schema/i);
    });

    it('throws when a required field (area) is missing — fail-fast', () => {
        const { area: _omit, ...missingArea } = validTourPayload;
        void _omit;
        expect(() => parseSystemTourResponse(JSON.stringify(missingArea))).toThrow(/schema/i);
    });
});

// ─── (c) system-prompt honesty rules ─────────────────────────────────────────

describe('buildSystemTourSystemPrompt', () => {
    const prompt = buildSystemTourSystemPrompt(baseCaseStudy);

    it('instructs grounding strictly in the provided case study', () => {
        expect(prompt).toMatch(/provided case study/i);
        expect(prompt).toMatch(/only evidence|sole evidence|only source/i);
    });

    it('requires systemMap to reuse the architecture verbatim', () => {
        expect(prompt).toMatch(/systemMap/);
        expect(prompt).toMatch(/verbatim/i);
        expect(prompt).toMatch(/architecture/i);
    });

    it('restricts whatIdChange to evidenced limitations and allows []', () => {
        expect(prompt).toMatch(/whatIdChange/);
        expect(prompt).toMatch(/challenges|depthMarkers/i);
        expect(prompt).toMatch(/\[\]|empty/i);
        expect(prompt).toMatch(/never invent|do not invent|never fabricate/i);
    });
});

// ─── forced-tool def parity ──────────────────────────────────────────────────

describe('SYSTEM_TOUR_TOOL', () => {
    it('is a forced-tool def whose inputSchema mirrors SystemTourSchema', () => {
        expect(SYSTEM_TOUR_TOOL.name).toBeTruthy();
        const props = SYSTEM_TOUR_TOOL.inputSchema.properties;
        expect(Object.keys(props).sort()).toEqual(
            ['area', 'context', 'keyDecisions', 'outcomes', 'systemMap', 'tradeoffs', 'whatIdChange'],
        );
        expect(SYSTEM_TOUR_TOOL.inputSchema.additionalProperties).toBe(false);
    });
});
