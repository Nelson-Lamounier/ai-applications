/**
 * @format
 * LOCAL extract preview — runs each skill source and dumps EXACTLY what it would
 * extract, with NO database, NO AWS, and NO writes. Run this before any import
 * to understand the data: per-source counts, category distribution, samples, and
 * the full entry list as JSON you can inspect.
 *
 *   npx tsx applications/ontology-importer/src/run-skill-extract.ts
 *
 * Env (all optional):
 *   CURATED_SKILLS_PATH   override the curated data file
 *   ONET_BUNDLE_PATH      local path to a downloaded O*NET file — when set, the
 *                         O*NET source is previewed too (parser lands in T011)
 *   EXTRACT_OUT_DIR       output directory (default: ./skill-extract-out)
 *
 * Exit 0 always on success; this tool never mutates anything.
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { CuratedSkillSource } from './sources/CuratedSkillSource.js';
import type { SkillSource, RawImportEntry } from './sources/SkillSource.js';

// __dirname works under both the CommonJS build (dist/) and tsx (src/); the data
// dir sits one level up from either, so ../data resolves the same way.
const CURATED_PATH = process.env['CURATED_SKILLS_PATH']
    ?? join(__dirname, '../data/curated-skills.json');
const OUT_DIR = process.env['EXTRACT_OUT_DIR'] ?? 'skill-extract-out';

interface SourcePreview {
    name: string;
    licence: string;
    total: number;
    categoryDistribution: Record<string, number>;
    sample: string[];
    allEntries: RawImportEntry[];
}

async function previewSource(src: SkillSource): Promise<SourcePreview> {
    const allEntries: RawImportEntry[] = [];
    for await (const e of src.fetch()) allEntries.push(e);
    const categoryDistribution: Record<string, number> = {};
    for (const e of allEntries) {
        const cat = String((e.source_metadata as { category?: unknown })?.category ?? '(uncategorised)');
        categoryDistribution[cat] = (categoryDistribution[cat] ?? 0) + 1;
    }
    return {
        name: src.name,
        licence: src.licence,
        total: allEntries.length,
        categoryDistribution,
        sample: allEntries.slice(0, 10).map((e) => e.proposed_canonical_name),
        allEntries,
    };
}

async function main(): Promise<void> {
    await mkdir(OUT_DIR, { recursive: true });

    const sources: SkillSource[] = [new CuratedSkillSource(CURATED_PATH)];
    // O*NET preview is wired here once ONET_BUNDLE_PATH + the parser (T011) exist.
    if (process.env['ONET_BUNDLE_PATH']) {
        console.log('[extract] ONET_BUNDLE_PATH set, but the O*NET parser (T011) is not built yet — skipping. Build OnetSkillSource to preview it.');
    }

    for (const src of sources) {
        const p = await previewSource(src);
        const file = `${OUT_DIR}/extract-${src.name}.json`;
        await writeFile(file, JSON.stringify(p, null, 2));
        console.log(`\n=== source: ${p.name}  (licence: ${p.licence}) ===`);
        console.log(`total entries:           ${p.total}`);
        console.log(`category distribution:   ${JSON.stringify(p.categoryDistribution)}`);
        console.log(`sample canonicals:       ${p.sample.join(', ')}`);
        console.log(`full extract written to: ${file}`);
    }

    console.log('\nNo database writes, no AWS calls. Inspect the JSON above before running the import Job.');
}

main().then(() => process.exit(0)).catch((err) => { console.error('[extract] failed:', err); process.exit(1); });
