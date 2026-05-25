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
    /** Pattern rules with their regexes pre-compiled once (classify runs over millions of entries). */
    private readonly compiledRules: ReadonlyArray<{ re: RegExp; rule: PatternRule }> =
        (patterns as PatternRule[]).map((rule) => ({ re: new RegExp(rule.pattern), rule }));
    private readonly overrides = overrides as Record<string, string>;

    /** @param sourceMetadataCategory Layer-3 hint from the source, or null. */
    classify(entry: RawImportEntry, ecosystem: string, sourceMetadataCategory: string | null): CategorizationResult {
        // Layer 1 — pattern rules (first match wins).
        for (const { re, rule: r } of this.compiledRules) {
            if (r.ecosystem !== ecosystem) continue;
            if (!re.test(entry.source_identifier)) continue;
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
