/** @format */
import { readFile } from 'node:fs/promises';
import type { RawImportEntry } from '@bedrock/shared';
import type { SkillSource } from './SkillSource.js';

/** One curated skill row in the data file. */
interface CuratedSkill {
    canonical: string;
    display?:  string;
    category:  string;
    aliases?:  string[];
}
interface CuratedFile { licence?: string; skills: CuratedSkill[] }

/**
 * The project's curated engineering-capability vocabulary — the fast-moving tail
 * O*NET lacks (research D2), read from a JSON data file so it is reviewable + diff-
 * able in the repo. Each entry already carries its skill category in
 * `source_metadata.category` (curated entries are pre-categorised; only O*NET
 * needs the categoriser). Licence `curated` (own work, commercial-safe).
 */
export class CuratedSkillSource implements SkillSource {
    readonly name = 'curated';
    readonly licence = 'curated';

    constructor(private readonly dataPath: string) {}

    async *fetch(): AsyncIterable<RawImportEntry> {
        const parsed = JSON.parse(await readFile(this.dataPath, 'utf-8')) as CuratedFile;
        for (const s of parsed.skills) {
            const canonical = s.canonical.toLowerCase().trim();
            if (!canonical) continue;
            const aliases = (s.aliases ?? []).map((a) => a.toLowerCase().trim()).filter(Boolean);
            yield {
                source_identifier:       canonical,
                proposed_canonical_name: canonical,
                proposed_display_name:   s.display ?? s.canonical,
                keywords:                aliases,
                source_metadata:         { category: s.category, aliases },
            };
        }
    }
}
