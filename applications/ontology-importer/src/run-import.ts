/** @format */
import { Pool } from 'pg';
import {
    OntologyImportRunRepository, OntologyImportSourceRepository, OntologyWriteRepository,
    OntologyReviewQueueRepository,
    bootstrapK8sObservability, pushFinalMetrics,
} from '@bedrock/shared';
import type { ImportRunCounts } from '@bedrock/shared';

import { parseEnv } from './env.js';
import { ALL_SOURCES } from './sources/index.js';
import { Categorizer } from './categorization/Categorizer.js';
import { OntologyImporter } from './importer/OntologyImporter.js';
import { BedrockBatchClassifier, buildJsonlRecords } from './categorization/BedrockBatchClassifier.js';
import type { PooledItem } from './categorization/BedrockBatchClassifier.js';
import { buildMetrics } from './metrics.js';

const obs = bootstrapK8sObservability({ serviceName: 'ontology-importer' });
const log = obs.logger;
const metrics = buildMetrics(obs.registry);

async function withTimeout(p: Promise<unknown>, ms: number, label: string): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => { timer = setTimeout(() => { log.warn({ label }, 'teardown timed out'); resolve(); }, ms); });
    try { await Promise.race([p.then(() => undefined).catch(() => undefined), timeout]); }
    finally { if (timer) clearTimeout(timer); }
}

const emptyCounts = (): ImportRunCounts => ({
    entriesFetched: 0, entriesInserted: 0, entriesUpdated: 0, entriesDeactivated: 0,
    aliasMerges: 0, unresolvedCount: 0, reviewQueueAdded: 0,
});

async function main(): Promise<void> {
    const env = parseEnv();
    const pool = new Pool({ ...env.pg, max: 3 });
    const runs = new OntologyImportRunRepository(pool);
    const ontology = new OntologyWriteRepository(pool);
    const importSources = new OntologyImportSourceRepository(pool);
    const reviewQueue = new OntologyReviewQueueRepository(pool);
    const importer = new OntologyImporter(new Categorizer(), ontology, importSources);
    const llm = new BedrockBatchClassifier({
        region: env.bedrock.region, bucket: env.bedrock.bucket, prefix: env.bedrock.prefix,
        roleArn: env.bedrock.roleArn, modelId: env.bedrock.modelId,
    });

    const pooled: PooledItem[] = [];

    try {
        for (const source of ALL_SOURCES()) {
            if (env.sources && !env.sources.includes(source.name)) continue;

            const runStart = new Date();
            const stopTimer = metrics.importDuration.startTimer({ source: source.name });
            const runId = await runs.begin(source.name, env.triggeredBy);
            try {
                const { counts, unresolved } = await importer.run(source, runStart);
                await importSources.incrementMissesOlderThan(source.name, runStart);
                counts.entriesDeactivated += await importSources.deactivateStale(source.name, env.deactivationThreshold);

                for (const entry of unresolved) pooled.push({ entry, ecosystem: source.ecosystem });

                await runs.finish(runId, 'success', counts, {});

                metrics.importEntries.inc({ source: source.name, outcome: 'inserted' }, counts.entriesInserted);
                metrics.importEntries.inc({ source: source.name, outcome: 'updated' }, counts.entriesUpdated);
                metrics.importEntries.inc({ source: source.name, outcome: 'deactivated' }, counts.entriesDeactivated);
                metrics.importEntries.inc({ source: source.name, outcome: 'unresolved' }, counts.unresolvedCount);
                if (counts.entriesFetched > 0) {
                    const resolved = counts.entriesInserted + counts.entriesUpdated;
                    metrics.resolutionRate.set({ ecosystem: source.ecosystem }, resolved / counts.entriesFetched);
                }
                log.info({ source: source.name, ...counts }, 'import.source.complete');
            } catch (err) {
                await runs.finish(runId, 'failed', emptyCounts(), { errorSummary: String(err) }).catch(() => {});
                log.error({ source: source.name, err: String(err) }, 'import.source.failed');
            } finally {
                stopTimer();
            }
        }

        // Pooled Layer-4 batch across all sources.
        if (pooled.length >= env.bedrock.minRecords) {
            const runKey = `import_${Date.now()}`;
            const { records, recordMap } = buildJsonlRecords(pooled);
            const jobArn = await llm.submit(records, runKey);
            await runs.recordBatchRun('pooled_llm_batch', env.triggeredBy, jobArn, recordMap, runKey);
            log.info({ pooled: pooled.length, jobArn }, 'import.batch.submitted');
        } else if (pooled.length > 0) {
            for (const { entry, ecosystem } of pooled) {
                await reviewQueue.add({ rawName: entry.source_identifier, ecosystem, source: 'pooled_llm_batch', reason: 'llm_maybe', suggestedCategory: null, llmReasoning: 'below MIN_BATCH_RECORDS' }).catch(() => {});
            }
            log.info({ pooled: pooled.length, min: env.bedrock.minRecords }, 'import.batch.below_min.queued_for_review');
        }
    } finally {
        await withTimeout(pool.end(), 10_000, 'pg-pool');
        // Bounded key: constant "global", never a per-run timestamp (see pushgateway.ts).
        await withTimeout(pushFinalMetrics(obs.registry, 'ontology-importer', 'global'), 8_000, 'pushgateway');
        await withTimeout(obs.shutdown(), 10_000, 'otel-shutdown');
    }
}

main().then(() => process.exit(0)).catch((err) => { log.error({ err: String(err) }, 'failed'); process.exit(1); });
