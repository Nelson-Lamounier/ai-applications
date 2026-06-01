/** @format */
import { describe, it, expect } from '@jest/globals';
import { buildStagePrepConstraintBlock, normalizeCompanyKey } from './constraint-block.js';
import type { StagePrepConstraints } from './constraint-block.js';

const FULL: StagePrepConstraints = {
    expectation: {
        id: '*|*|phone-screen', companyType: '*', roleFamily: '*', stage: 'phone-screen',
        focusAreas: ['career arc', 'comp alignment'],
        questionPatterns: [{ type: 'career-arc', promptHint: 'walk me through your background' }],
        expectationNote: 'Recruiter-led fit filter.',
    },
    processShape: [{ stage: 'phone-screen', format: 'recruiter screen', note: 'fit + logistics' }],
    comp: {
        id: '*|senior|eu-remote', roleFamily: '*', seniority: 'senior', region: 'eu-remote',
        currency: 'EUR', rangeMin: 80647, rangeP50: 93794, rangeMax: 114300,
    },
    gapTemplates: [{
        id: 'gap-adjacent-pivot', kind: 'gap_handling', title: 'Acknowledge gap, pivot',
        structure: { template: 'I have not used {missing} but {adjacent}...' },
    }],
    compTarget: '95000',
};

describe('buildStagePrepConstraintBlock', () => {
    it('renders focus areas, process, comp range+target, and gap guidance', () => {
        const block = buildStagePrepConstraintBlock(FULL);
        expect(block).toContain('career arc');
        expect(block).toContain('recruiter screen');
        expect(block).toContain('93794');
        expect(block).toContain('95000');
        expect(block).toContain('EUR');
        expect(block).toContain('gap');
        expect(block.toLowerCase()).toContain('never');
    });
    it('omits absent pieces and still returns the truthfulness reminder', () => {
        const empty: StagePrepConstraints = {
            expectation: null, processShape: [], comp: null, gapTemplates: [], compTarget: null,
        };
        const block = buildStagePrepConstraintBlock(empty);
        expect(block).not.toContain('Market compensation');
        expect(block).not.toContain('Typical process');
        expect(block.toLowerCase()).toContain('never');
    });
    it('shows comp target without a market range when comp is null', () => {
        const block = buildStagePrepConstraintBlock({ ...FULL, comp: null });
        expect(block).toContain('95000');
        expect(block).not.toContain('93794');
    });
});

describe('normalizeCompanyKey', () => {
    it('lowercases and strips to alphanumerics', () => {
        expect(normalizeCompanyKey('Amazon Web Services, Inc.')).toBe('amazonwebservicesinc');
        expect(normalizeCompanyKey('Stripe')).toBe('stripe');
    });
});

import { loadStagePrepConstraints } from './constraint-block.js';
import type { StagePrepOntologyReader } from './constraint-block.js';

function fakeReader(over: Partial<StagePrepOntologyReader> = {}): StagePrepOntologyReader {
    return {
        getStageExpectation: async () => null,
        getCompanyProfile:   async () => null,
        getCompBenchmark:    async () => null,
        listScaffolds:       async () => [],
        ...over,
    };
}

describe('loadStagePrepConstraints', () => {
    it('uses companyType from the profile and passes it to getStageExpectation', async () => {
        let seenCompanyType = '';
        const reader = fakeReader({
            getCompanyProfile: async () => ({
                companyKey: 'amazon', displayName: 'Amazon', companyType: 'faang',
                leadershipPrinciples: [], processShape: [{ stage: 'phone-screen', format: 'recruiter screen', note: 'n' }],
                valuesTaxonomy: [],
            }),
            getStageExpectation: async (ct) => { seenCompanyType = ct; return null; },
        });
        const c = await loadStagePrepConstraints(reader, {
            targetCompany: 'Amazon', roleFamily: 'backend', stage: 'phone-screen',
            seniority: 'senior', region: 'us', compTarget: '200000',
        });
        expect(seenCompanyType).toBe('faang');
        expect(c.processShape).toHaveLength(1);
        expect(c.compTarget).toBe('200000');
    });
    it('falls back to companyType "*" when the company is unknown', async () => {
        let seenCompanyType = '';
        const reader = fakeReader({ getStageExpectation: async (ct) => { seenCompanyType = ct; return null; } });
        await loadStagePrepConstraints(reader, {
            targetCompany: 'Some Unknown GmbH', roleFamily: 'devops', stage: 'phone-screen',
            seniority: 'mid', region: 'eu-remote', compTarget: null,
        });
        expect(seenCompanyType).toBe('*');
    });
});
