/** @format */
import type { RawImportEntry } from '@bedrock/shared';
import type { SkillSource } from './SkillSource.js';
import { mapTechCategoryToSkillCategory } from '../categorization/skill-patterns.js';

/** One technology_ontology canonical + its aliases (already registry-imported). */
export interface TechOntologyRow {
    readonly canonical_name: string;
    readonly category: string;
    readonly aliases: string[];
}

/**
 * Derives skill canonicals from the already-imported technology_ontology
 * (~2,483 canonicals + ~4,059 aliases): each tool canonical is surfaced into the
 * skill lane under a mapped skill category, so tool-centric skill phrases ("react
 * hooks" -> "react") collapse. Research D7's second lever; replaces the dropped
 * O*NET source.
 *
 * The rows are supplied by a provider so the source is decoupled from the DB:
 *   - production: a pool query over technology_ontology + technology_aliases
 *   - tests / local preview: a fixture or a pulled JSON export
 * Anything that keeps technology_ontology fresh (e.g. a future JD-driven agent)
 * flows into the skill lane for free — this source is just a read of that table.
 *
 * Licence `derived`: only the canonical NAMES are surfaced (names are not
 * copyrightable); the underlying registry data was already vetted by the
 * technology importer.
 */
export class TechnologyDerivedSkillSource implements SkillSource {
    readonly name = 'technology_ontology';
    readonly licence = 'derived';

    constructor(private readonly loadRows: () => Promise<readonly TechOntologyRow[]>) {}

    async *fetch(): AsyncIterable<RawImportEntry> {
        for (const row of await this.loadRows()) {
            const raw = row.canonical_name.toLowerCase().trim();
            if (!raw) continue;
            // Tech canonicals are underscore-joined (aws_cdk); LLM skill phrases
            // use spaces (aws cdk). Normalise the skill canonical to the spaced
            // form and keep the underscore form as an alias so both resolve.
            const canonical = raw.replaceAll('_', ' ');
            const aliases = new Set<string>();
            if (raw !== canonical) aliases.add(raw);
            for (const a of row.aliases ?? []) {
                const cleaned = a.toLowerCase().trim();
                if (cleaned) aliases.add(cleaned);
            }
            yield {
                source_identifier:       canonical,
                proposed_canonical_name: canonical,
                proposed_display_name:   row.canonical_name,
                keywords:                [...aliases],
                source_metadata:         { category: mapTechCategoryToSkillCategory(row.category), aliases: [...aliases], derived_from: 'technology_ontology' },
            };
        }
    }
}
