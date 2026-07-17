/** @format */
import { describe, it, expect } from '@jest/globals';

import { computeLayerParity } from './layer-parity.js';
import type { EvidenceKey } from './layer-parity.js';

function key(over: Partial<EvidenceKey> = {}): EvidenceKey {
    return {
        sourceLayer: 'treesitter',
        canonicalId: 'typescript',
        filePath:    'src/index.ts',
        ...over,
    };
}

describe('computeLayerParity', () => {
    it('returns an empty result for empty inputs', () => {
        expect(computeLayerParity([], [])).toEqual([]);
    });

    it('reports full overlap when both sides carry the same layer keys', () => {
        const legacy  = [key(), key({ canonicalId: 'react', filePath: 'src/App.tsx' })];
        const unified = [key(), key({ canonicalId: 'react', filePath: 'src/App.tsx' })];

        const result = computeLayerParity(legacy, unified);

        expect(result).toEqual([
            {
                sourceLayer:          'treesitter',
                legacyCount:          2,
                unifiedCount:         2,
                intersectionCount:    2,
                legacyOnlyExamples:   [],
                unifiedOnlyExamples:  [],
            },
        ]);
    });

    it('reports a legacy-only layer with unifiedCount 0 and no intersection', () => {
        const legacy = [key({ sourceLayer: 'dockerfile' })];

        const result = computeLayerParity(legacy, []);

        expect(result).toEqual([
            {
                sourceLayer:          'dockerfile',
                legacyCount:          1,
                unifiedCount:         0,
                intersectionCount:    0,
                legacyOnlyExamples:   ['typescript src/index.ts'],
                unifiedOnlyExamples:  [],
            },
        ]);
    });

    it('reports a unified-only layer with legacyCount 0 and no intersection', () => {
        const unified = [key({ sourceLayer: 'iac' })];

        const result = computeLayerParity([], unified);

        expect(result).toEqual([
            {
                sourceLayer:          'iac',
                legacyCount:          0,
                unifiedCount:         1,
                intersectionCount:    0,
                legacyOnlyExamples:   [],
                unifiedOnlyExamples:  ['typescript src/index.ts'],
            },
        ]);
    });

    it('computes the correct intersection count for partial overlap', () => {
        const legacy = [
            key({ canonicalId: 'typescript', filePath: 'src/index.ts' }),
            key({ canonicalId: 'react',      filePath: 'src/App.tsx' }),
            key({ canonicalId: 'jest',       filePath: 'src/App.test.ts' }),
        ];
        const unified = [
            key({ canonicalId: 'typescript', filePath: 'src/index.ts' }),
            key({ canonicalId: 'react',      filePath: 'src/App.tsx' }),
            key({ canonicalId: 'eslint',     filePath: '.eslintrc.js' }),
        ];

        const [result] = computeLayerParity(legacy, unified);

        expect(result.legacyCount).toBe(3);
        expect(result.unifiedCount).toBe(3);
        expect(result.intersectionCount).toBe(2);
        expect(result.legacyOnlyExamples).toEqual(['jest src/App.test.ts']);
        expect(result.unifiedOnlyExamples).toEqual(['eslint .eslintrc.js']);
    });

    it('caps example lists at 20 keys', () => {
        const legacy = Array.from({ length: 25 }, (_, i) =>
            key({ canonicalId: `tech-${i}`, filePath: `src/file-${i}.ts` }));

        const [result] = computeLayerParity(legacy, []);

        expect(result.legacyCount).toBe(25);
        expect(result.legacyOnlyExamples).toHaveLength(20);
    });

    it('handles a null filePath in the comparable key without colliding with a non-null value', () => {
        const legacy = [
            key({ canonicalId: 'typescript', filePath: null }),
            key({ canonicalId: 'typescript', filePath: 'src/index.ts' }),
        ];
        const unified = [
            key({ canonicalId: 'typescript', filePath: null }),
        ];

        const [result] = computeLayerParity(legacy, unified);

        expect(result.legacyCount).toBe(2);
        expect(result.unifiedCount).toBe(1);
        expect(result.intersectionCount).toBe(1);
        expect(result.legacyOnlyExamples).toEqual(['typescript src/index.ts']);
        expect(result.unifiedOnlyExamples).toEqual([]);
    });

    it('produces one row per distinct sourceLayer across both sides', () => {
        const legacy  = [key({ sourceLayer: 'treesitter' }), key({ sourceLayer: 'dockerfile' })];
        const unified = [key({ sourceLayer: 'treesitter' }), key({ sourceLayer: 'iac' })];

        const result = computeLayerParity(legacy, unified);
        const layers = result.map((r) => r.sourceLayer).sort();

        expect(layers).toEqual(['dockerfile', 'iac', 'treesitter']);
    });
});
