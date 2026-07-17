/** @format */
import { describe, it, expect } from '@jest/globals';
import {
    buildVerifiedStackMap,
    stampStackSignals,
    type VerifiedTechRow,
} from './case-study-verified-stack.js';
import type { SourceSignal } from './case-study-types.js';

function signals(over: Partial<SourceSignal> = {}): SourceSignal {
    return { commits: [], pulls: [], files: [], ungroundedClaims: [], grounding: 'NOT_VERIFIED', ...over };
}

const rows: VerifiedTechRow[] = [
    { canonicalName: 'React', version: '18.3.1', purl: 'pkg:npm/react@18.3.1', filePath: 'package.json', lineStart: 24 },
    // Same canonical, a version-less duplicate from a non-syft lane — the
    // version-bearing row must win.
    { canonicalName: 'react', version: null, purl: 'pkg:npm/react', filePath: 'package.json', lineStart: 90 },
    { canonicalName: 'PostgreSQL', version: null, purl: 'pkg:generic/postgresql', filePath: 'docker-compose.yml', lineStart: 12 },
];

describe('buildVerifiedStackMap', () => {
    it('keys by lowercased canonical and prefers the version-bearing row', () => {
        const map = buildVerifiedStackMap(rows);
        const react = map.get('react');
        expect(react?.version).toBe('18.3.1');
        expect(react?.purl).toBe('pkg:npm/react@18.3.1');
        expect(react?.line).toBe(24);
    });

    it('keeps version-less entries (infra/db without a package version)', () => {
        const map = buildVerifiedStackMap(rows);
        expect(map.get('postgresql')?.version).toBeNull();
        expect(map.get('postgresql')?.purl).toBe('pkg:generic/postgresql');
    });
});

describe('stampStackSignals', () => {
    const map = buildVerifiedStackMap(rows);

    it('stamps verifiedTech AND marks GROUNDED when the stack name matches a code dependency', () => {
        const out = stampStackSignals('React', signals(), map);
        expect(out.verifiedTech).toEqual([
            { name: 'React', version: '18.3.1', purl: 'pkg:npm/react@18.3.1', path: 'package.json', line: 24 },
        ]);
        // An SBOM match (version + purl + file:line) is the strongest grounding —
        // it is marked GROUNDED, not left at the model's guess, and invents nothing.
        expect(out.grounding).toBe('GROUNDED');
        expect(out.ungroundedClaims).toEqual([]);
    });

    it('matches case-insensitively (normaliser)', () => {
        expect(stampStackSignals('postgresql', signals(), map).verifiedTech?.[0]?.purl)
            .toBe('pkg:generic/postgresql');
    });

    it('flags an unmatched item that has no other evidence', () => {
        const out = stampStackSignals('Kafka', signals(), map);
        expect(out.verifiedTech).toBeUndefined();
        expect(out.grounding).toBe('NOT_GROUNDED');
        expect(out.ungroundedClaims).toContain('stack item "Kafka" not found in code dependencies');
    });

    it('does NOT flag an unmatched item that carries commit/file evidence', () => {
        const withEvidence = signals({ files: [{ repoFullName: 'o/r', path: 'infra/main.tf' }] });
        const out = stampStackSignals('Terraform', withEvidence, map);
        expect(out.verifiedTech).toBeUndefined();
        expect(out.grounding).toBe('NOT_VERIFIED'); // unchanged
        expect(out.ungroundedClaims).toEqual([]);
    });

    it('never downgrades an already-GROUNDED signal', () => {
        const out = stampStackSignals('Kafka', signals({ grounding: 'GROUNDED' }), map);
        expect(out.grounding).toBe('GROUNDED');
    });
});
