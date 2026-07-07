/**
 * @format
 * CaseStudySchema is the acceptance gate for BOTH fresh model output
 * (case-study-agent parse) and semantic-cache hits (orchestrator). The
 * generation contract (tool schema) was trimmed — depthMarkers removed,
 * bullets capped — but the Zod gate stays tolerant so pre-trim cached
 * artefacts keep validating instead of forcing regeneration.
 */
import { describe, it, expect } from '@jest/globals';

import { CaseStudySchema, RESUME_BULLET_ANGLES } from './case-study-types.js';

const minimal = {
    tagline: 'A tagline',
    pitch:   'A pitch',
    stack:        [],
    decisions:    [],
    highlights:   [],
    challenges:   [],
    architecture: { diagramFormat: 'mermaid', diagramSource: 'graph TD; a-->b', nodes: [], edges: [] },
    resumeBullets: [{ angle: 'backend', bullets: ['Did a thing'] }],
};

describe('CaseStudySchema — depthMarkers optional (model no longer emits it)', () => {
    it('accepts a case study without depthMarkers', () => {
        expect(CaseStudySchema.safeParse(minimal).success).toBe(true);
    });

    it('still accepts depthMarkers when present (pre-trim cached artefacts)', () => {
        const withDepth = {
            ...minimal,
            depthMarkers: {
                hasTests: false, testCoverageSignal: 'none', hasCi: false,
                ciMaturity: 'none', documentationDensity: 'readme_only',
                hasDeploymentEvidence: false, refactorCount: 0,
            },
        };
        expect(CaseStudySchema.safeParse(withDepth).success).toBe(true);
    });

    it('keeps accepting 6 angle sets / 500-char bullets (cache tolerance; generation asks 3/250)', () => {
        const six = RESUME_BULLET_ANGLES.map((angle) => ({ angle, bullets: ['x'.repeat(500)] }));
        expect(CaseStudySchema.safeParse({ ...minimal, resumeBullets: six }).success).toBe(true);
    });
});
