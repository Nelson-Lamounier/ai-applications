/**
 * @format
 * Skill vocabulary import Job (spec 001, US1). Imports the skill canonicals from
 * the enabled sources into `skill_ontology`, then embeds the new ones so the
 * resolver picks them up — the step that actually lands the vocabulary.
 *
 * Sources (research D7/D7a — O*NET dropped):
 *   - curated:              the project's engineering vocabulary (PRIMARY)
 *   - technology_ontology:  the 106 CURATED tech canonicals, derived into skills
 * Both pre-categorise, so there is NO LLM categoriser and NO Bedrock dependency
 * in the import loop — the only AWS call is the Titan embedding backfill at the
 * end.
 *
 * Env (contracts/skill-importer.md): PG_*, AWS_REGION, SKILL_IMPORT_SOURCES,
 * DRY_RUN (=1 → fetch + count, write nothing). Reference data — global, no RLS.
 *
 * Exit: 0 = complete (per-entry skips are non-fatal), 1 = fatal (env/DB/Bedrock).
 */
import { Pool } from 'pg';
import { join } from 'node:path';
import {
    SkillOntologyWriteRepository,
    SkillOntologyRepository,
    OntologyImportRunRepository,
    TitanEmbeddingProvider,
    backfillSkillEmbeddings,
    dedupeSkillCanonicals,
    bootstrapK8sObservability,
    pushFinalMetrics,
    type ImportRunCounts,
} from '@bedrock/shared';
import { CuratedSkillSource } from './sources/CuratedSkillSource.js';
import { TechnologyDerivedSkillSource, type TechOntologyRow } from './sources/TechnologyDerivedSkillSource.js';
import type { SkillSource } from './sources/SkillSource.js';

const obs = bootstrapK8sObservability({ serviceName: 'skill-import' });
const log = obs.logger;

/** Sources allowed to write (licence allowlist — SC-003). */
const ALLOWED_LICENCES = new Set(['curated', 'derived']);
/** The resolver index is vector(1024); the backfill must match. */
const EMBEDDING_DIMENSION = 1024;

/** The write operations the loop needs — narrowed for testability. */
export interface SkillWriteOps {
    insertAutoImported(canonical: string, display: string, category: string, source: string, licence: string, url: string | null): Promise<{ id: string; curatedSkip: boolean }>;
    insertAliases(id: string, aliases: readonly string[], source: string): Promise<number>;
}

function emptyCounts(): ImportRunCounts {
    return { entriesFetched: 0, entriesInserted: 0, entriesUpdated: 0, entriesDeactivated: 0, aliasMerges: 0, unresolvedCount: 0, reviewQueueAdded: 0 };
}

/**
 * Drain one source into the write repo, mutating `counts`. Licence-gated (an
 * off-allowlist source writes nothing). On a curated collision the import's name
 * + aliases attach as aliases of the curated canonical (FR-008). DRY_RUN counts
 * without writing. Exported for the integration test.
 */
export async function importSource(
    src: SkillSource,
    write: SkillWriteOps,
    dryRun: boolean,
    counts: ImportRunCounts,
): Promise<void> {
    if (!ALLOWED_LICENCES.has(src.licence)) {
        log.warn({ source: src.name, licence: src.licence }, 'skill_import.source_rejected (licence not on allowlist)');
        return;
    }
    for await (const entry of src.fetch()) {
        counts.entriesFetched++;
        const meta = entry.source_metadata as { category?: unknown; aliases?: unknown };
        const category = typeof meta?.category === 'string' ? meta.category : 'other';
        const aliases = Array.isArray(meta?.aliases) ? (meta.aliases as string[]) : (entry.keywords ?? []);
        if (dryRun) { counts.entriesInserted++; continue; }

        const { id, curatedSkip } = await write.insertAutoImported(
            entry.proposed_canonical_name, entry.proposed_display_name, category, src.name, src.licence, null,
        );
        if (curatedSkip) {
            counts.aliasMerges += await write.insertAliases(id, [entry.proposed_canonical_name, ...aliases], src.name);
        } else {
            counts.entriesInserted++;
            counts.aliasMerges += await write.insertAliases(id, aliases, src.name);
        }
    }
}

/** Provider: the 106 CURATED technology_ontology rows (D7a — excludes the noise). */
function loadCuratedTechRows(pool: Pool): () => Promise<readonly TechOntologyRow[]> {
    return async () => {
        const { rows } = await pool.query<{ canonical_name: string; category: string; aliases: string[] }>(
            `SELECT o.canonical_name, o.category,
                    coalesce(array_agg(a.alias) FILTER (WHERE a.alias IS NOT NULL), '{}') AS aliases
               FROM technology_ontology o
               LEFT JOIN technology_aliases a ON a.technology_id = o.id
              WHERE o.is_active AND o.curation_level = 'curated'
              GROUP BY o.canonical_name, o.category`,
        );
        return rows.map((r) => ({ canonical_name: r.canonical_name, category: r.category, aliases: r.aliases ?? [] }));
    };
}

function requireEnv(name: string): string {
    const v = process.env[name];
    if (!v) throw new Error(`Missing required env var: ${name}`);
    return v;
}

function buildPool(): Pool {
    return new Pool({
        host: requireEnv('PG_HOST'), port: Number.parseInt(process.env['PG_PORT'] ?? '5432', 10),
        database: requireEnv('PG_DATABASE'), user: requireEnv('PG_USER'), password: requireEnv('PG_PASSWORD'), max: 3,
    });
}

/** Build the enabled sources from SKILL_IMPORT_SOURCES (default: both). */
function buildSources(pool: Pool, enabled: ReadonlySet<string>): SkillSource[] {
    const sources: SkillSource[] = [];
    if (enabled.has('curated')) sources.push(new CuratedSkillSource(join(__dirname, '../data/curated-skills.json')));
    if (enabled.has('technology_ontology')) sources.push(new TechnologyDerivedSkillSource(loadCuratedTechRows(pool)));
    return sources;
}

/** Embed the new canonicals (no-op in dry-run). Extracted to keep main bounded. */
async function embedNewCanonicals(pool: Pool, region: string, dryRun: boolean): Promise<number> {
    if (dryRun) return 0;
    const embedder = new TitanEmbeddingProvider(region, EMBEDDING_DIMENSION);
    return backfillSkillEmbeddings(new SkillOntologyRepository(pool), embedder);
}

/**
 * Near-duplicate pass (FR-006, US3) over the now-embedded canonicals: auto-merge
 * pairs >= DEDUP_AUTO_MERGE_THRESHOLD (default 0.85), log the [floor, auto) grey
 * band as review candidates. Runs after the embed (it needs vectors); no-op in
 * dry-run. Mutates `counts`.
 */
async function dedupeImported(pool: Pool, write: SkillOntologyWriteRepository, dryRun: boolean, counts: ImportRunCounts): Promise<void> {
    if (dryRun) return;
    const candidates = await new SkillOntologyRepository(pool).loadActiveWithEmbeddings();
    const actions = dedupeSkillCanonicals(candidates, {
        autoMergeThreshold: Number.parseFloat(process.env['DEDUP_AUTO_MERGE_THRESHOLD'] ?? '0.85'),
        reviewFloor:        Number.parseFloat(process.env['DEDUP_REVIEW_FLOOR'] ?? '0.70'),
    });
    const nameById = new Map(candidates.map((c) => [c.id, c.canonical]));
    for (const a of actions) {
        if (a.kind === 'merge') {
            await write.mergeCanonical(a.keepId, a.dropId, nameById.get(a.dropId) ?? '', 'auto-dedup');
            counts.entriesDeactivated++;
        } else {
            counts.reviewQueueAdded++;
            log.info({ keep: nameById.get(a.keepId), drop: nameById.get(a.dropId), similarity: a.similarity }, 'skill_import.dedup_review_candidate');
        }
    }
}

async function main(): Promise<void> {
    const pool = buildPool();
    const dryRun = process.env['DRY_RUN'] === '1';
    const region = process.env['AWS_REGION'] ?? process.env['AWS_DEFAULT_REGION'] ?? 'eu-west-1';
    const enabled = new Set((process.env['SKILL_IMPORT_SOURCES'] ?? 'curated,technology_ontology').split(',').map((s) => s.trim()));

    const runs = new OntologyImportRunRepository(pool);
    const write = new SkillOntologyWriteRepository(pool);
    const counts = emptyCounts();
    const runId = dryRun ? null : await runs.begin('skill_vocabulary', 'manual');

    log.info({ event: 'skill_import.start', dryRun, sources: [...enabled] }, 'starting skill vocabulary import');
    try {
        for (const src of buildSources(pool, enabled)) await importSource(src, write, dryRun, counts);
        const embedded = await embedNewCanonicals(pool, region, dryRun);
        await dedupeImported(pool, write, dryRun, counts);
        if (runId) await runs.finish(runId, 'success', counts);
        log.info({ event: 'skill_import.complete', dryRun, counts, embedded }, `imported ${counts.entriesInserted} canonical(s), ${counts.aliasMerges} alias(es); embedded ${embedded}`);
    } catch (err) {
        if (runId) await runs.finish(runId, 'failed', counts, { errorSummary: String(err) }).catch(() => { /* best-effort */ });
        throw err;
    } finally {
        await pool.end().catch(() => { /* best-effort drain */ });
        await pushFinalMetrics(obs.registry, 'skill-import', 'global').catch(() => { /* best-effort */ });
        await obs.shutdown().catch(() => { /* flush spans */ });
    }
}

// Only run as a Job when executed directly — importing the module (e.g. the
// integration test for importSource) must not trigger main().
if (require.main === module) {
    main().then(() => process.exit(0)).catch((err) => { log.error({ err }, 'skill_import.failed'); process.exit(1); });
}
