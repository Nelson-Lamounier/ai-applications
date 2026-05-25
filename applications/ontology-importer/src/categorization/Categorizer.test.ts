/** @format */
import { describe, it, expect } from '@jest/globals';
import { Categorizer } from './Categorizer.js';
import type { RawImportEntry } from '@bedrock/shared';

function entry(name: string, extra: Partial<RawImportEntry> = {}): RawImportEntry {
    return { source_identifier: name, proposed_canonical_name: name, proposed_display_name: name, source_metadata: {}, ...extra };
}

describe('Categorizer (layers 1-3)', () => {
    const c = new Categorizer();

    it('Layer 1: pattern match assigns category', () => {
        const r = c.classify(entry('@nestjs/core'), 'npm', null);
        expect(r).toMatchObject({ decision: 'yes', category: 'framework_web', via: 'pattern' });
    });
    it('Layer 1: skip action → decision no', () => {
        expect(c.classify(entry('@types/node'), 'npm', null).decision).toBe('no');
    });
    it('Layer 2: override when no pattern', () => {
        const r = c.classify(entry('prisma'), 'npm', null);
        expect(r).toMatchObject({ category: 'database_relational', via: 'override' });
    });
    it('Layer 3: source metadata category when no pattern/override', () => {
        const r = c.classify(entry('some-pkg'), 'pypi', 'framework_web');
        expect(r).toMatchObject({ category: 'framework_web', via: 'source_metadata' });
    });
    it('falls through to none when nothing matches', () => {
        expect(c.classify(entry('totally-unknown-xyz'), 'npm', null).via).toBe('none');
    });
});
