/** @format */
/**
 * One-shot bootstrap job: tag every NULL-prose_safe row in technology_aliases
 * via Bedrock Converse (Haiku 4.5 inference profile).
 *
 * Run as a K8s Job in the ontology-importer namespace — inherits Pod Identity
 * (bedrock:InvokeModel on inference-profile/*) and platform-rds-credentials.
 *
 * Idempotent: queries WHERE prose_safe IS NULL, so re-runs only label the
 * remaining gaps. Each UPDATE writes one row; failures don't roll back.
 */
import { Pool } from 'pg';
import { bootstrapK8sObservability, pushFinalMetrics } from '@bedrock/shared';

import { parseEnv } from './env.js';
import {
    ProseSafeTagger, PROSE_SAFE_MODEL_DEFAULT, verdictToProseSafe,
    type AliasItem,
} from './categorization/ProseSafeTagger.js';

const obs = bootstrapK8sObservability({ serviceName: 'ontology-importer-prose-tagger' });
const log = obs.logger;

async function withTimeout(p: Promise<unknown>, ms: number, label: string): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => { timer = setTimeout(() => { log.warn({ label }, 'teardown timed out'); resolve(); }, ms); });
    try { await Promise.race([p.then(() => undefined).catch(() => undefined), timeout]); }
    finally { if (timer) clearTimeout(timer); }
}

const CONCURRENCY = Number.parseInt(process.env['PROSE_TAG_CONCURRENCY'] ?? '8', 10);
const BATCH_SIZE  = Number.parseInt(process.env['PROSE_TAG_BATCH_SIZE']  ?? '500', 10);

async function tagBatch(pool: Pool, tagger: ProseSafeTagger, items: AliasItem[]): Promise<{ yes: number; no: number; maybe: number; errors: number }> {
    const counts = { yes: 0, no: 0, maybe: 0, errors: 0 };
    // Bounded concurrency via a worker pool of size CONCURRENCY.
    let cursor = 0;
    const worker = async (): Promise<void> => {
        while (cursor < items.length) {
            const i = cursor++;
            const item = items[i];
            try {
                const { verdict, reasoning } = await tagger.tag(item);
                const proseSafe = verdictToProseSafe(verdict);
                await pool.query(
                    `UPDATE technology_aliases SET prose_safe = $2 WHERE alias = $1`,
                    [item.alias, proseSafe],
                );
                if (verdict === 'yes') counts.yes++;
                else if (verdict === 'no') counts.no++;
                else counts.maybe++;
                if ((counts.yes + counts.no + counts.maybe) % 50 === 0) {
                    log.info({ done: counts.yes + counts.no + counts.maybe, total: items.length, ...counts }, 'prose-tag.progress');
                }
                if (i < 3 || verdict === 'maybe') log.debug({ alias: item.alias, verdict, reasoning }, 'prose-tag.row');
            } catch (err) {
                counts.errors++;
                log.warn({ alias: item.alias, err: String(err) }, 'prose-tag.row_failed');
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
    return counts;
}

async function main(): Promise<void> {
    const env = parseEnv();
    const pool = new Pool({ ...env.pg, max: CONCURRENCY + 2 });
    const tagger = new ProseSafeTagger({ region: env.bedrock.region, modelId: env.bedrock.modelId || PROSE_SAFE_MODEL_DEFAULT });

    const totalAgg = { yes: 0, no: 0, maybe: 0, errors: 0 };
    try {
        // page through unclassified aliases
        // (no offset needed: each loop iter re-queries WHERE prose_safe IS NULL,
        // which shrinks as we UPDATE; same effect as paginating with LIMIT but
        // resumable on crash without holding a cursor)
        for (;;) {
            const { rows } = await pool.query<{ alias: string; canonical: string; category: string }>(
                `SELECT a.alias, o.canonical_name AS canonical, o.category
                   FROM technology_aliases a
                   JOIN technology_ontology o ON o.id = a.technology_id
                  WHERE a.prose_safe IS NULL
                  ORDER BY length(a.alias), a.alias
                  LIMIT $1`,
                [BATCH_SIZE],
            );
            if (rows.length === 0) break;
            log.info({ batch: rows.length }, 'prose-tag.batch.start');
            const counts = await tagBatch(pool, tagger, rows.map((r) => ({ alias: r.alias, canonical: r.canonical, category: r.category })));
            totalAgg.yes += counts.yes; totalAgg.no += counts.no; totalAgg.maybe += counts.maybe; totalAgg.errors += counts.errors;
            log.info({ batch: rows.length, ...counts, total: totalAgg }, 'prose-tag.batch.complete');
            if (counts.errors === rows.length) {
                log.error({}, 'prose-tag.batch.all_failed_abort');
                break;
            }
        }
        log.info({ ...totalAgg }, 'prose-tag.complete');
    } finally {
        await withTimeout(pool.end(), 10_000, 'pg-pool');
        // Bounded key: constant "global", never a per-run timestamp — prose-tagger variant (see pushgateway.ts).
        await withTimeout(pushFinalMetrics(obs.registry, 'ontology-importer-prose-tagger', 'global'), 8_000, 'pushgateway');
        await withTimeout(obs.shutdown(), 10_000, 'otel-shutdown');
    }
}

main().then(() => process.exit(0)).catch((err) => { log.error({ err: String(err) }, 'failed'); process.exit(1); });
