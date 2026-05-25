/** @format */
import type { OntologyCategory, CategorizationResult, RawImportEntry } from '@bedrock/shared';
import { ONTOLOGY_CATEGORIES } from '@bedrock/shared';
import patterns from './patterns.json';
import overrides from './overrides.json';

interface PatternRule { pattern: string; ecosystem: string; category?: string; action?: 'skip' }

const VALID = new Set<string>(ONTOLOGY_CATEGORIES);

/** Cascading classifier (layers 1-3). Layer 4 (LLM) is handled by the importer
 *  buffering `via:'none'` results for a batch call (Plan 3). */
export class Categorizer {
    private readonly rules = patterns as PatternRule[];
    private readonly overrides = overrides as Record<string, string>;

    /** @param sourceMetadataCategory Layer-3 hint from the source, or null. */
    classify(entry: RawImportEntry, ecosystem: string, sourceMetadataCategory: string | null): CategorizationResult {
        // Layer 1 — pattern rules (first match wins).
        for (const r of this.rules) {
            if (r.ecosystem !== ecosystem) continue;
            if (!new RegExp(r.pattern).test(entry.source_identifier)) continue;
            if (r.action === 'skip') return { decision: 'no', category: null, via: 'pattern' };
            if (r.category && VALID.has(r.category)) {
                return { decision: 'yes', category: r.category as OntologyCategory, via: 'pattern' };
            }
        }
        // Layer 2 — explicit overrides by canonical name.
        const ov = this.overrides[entry.proposed_canonical_name];
        if (ov && VALID.has(ov)) {
            return { decision: 'yes', category: ov as OntologyCategory, via: 'override' };
        }
        // Layer 3 — source-native metadata.
        if (sourceMetadataCategory && VALID.has(sourceMetadataCategory)) {
            return { decision: 'yes', category: sourceMetadataCategory as OntologyCategory, via: 'source_metadata' };
        }
        // Layer 4 deferred — buffered for LLM batch by the importer.
        return { decision: 'maybe', category: null, via: 'none' };
    }
}
