/** @format */
import { Pool } from 'pg';
import {
    OntologyImportRunRepository, OntologyImportSourceRepository, OntologyWriteRepository,
    bootstrapK8sObservability, pushFinalMetrics,
} from '@bedrock/shared';
import type { ImportRunCounts } from '@bedrock/shared';

import { parseEnv } from './env.js';
import { ALL_SOURCES } from './sources/index.js';
import { Categorizer } from './categorization/Categorizer.js';
import { OntologyImporter } from './importer/OntologyImporter.js';
import { LlmBatchClassifier, buildBatchRequests } from './categorization/LlmBatchClassifier.js';
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
    const importer = new OntologyImporter(new Categorizer(), ontology, importSources);
    const llm = new LlmBatchClassifier(env.anthropicApiKey);

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

                let llmBatchId: string | undefined;
                if (unresolved.length > 0) {
                    llmBatchId = await llm.submit(buildBatchRequests(unresolved, source.ecosystem));
                }

                await runs.finish(runId, unresolved.length > 0 ? 'partial' : 'success', counts, { llmBatchId });

                metrics.importEntries.inc({ source: source.name, outcome: 'inserted' }, counts.entriesInserted);
                metrics.importEntries.inc({ source: source.name, outcome: 'updated' }, counts.entriesUpdated);
                metrics.importEntries.inc({ source: source.name, outcome: 'deactivated' }, counts.entriesDeactivated);
                metrics.importEntries.inc({ source: source.name, outcome: 'unresolved' }, counts.unresolvedCount);
                if (counts.entriesFetched > 0) {
                    const resolved = counts.entriesInserted + counts.entriesUpdated;
                    metrics.resolutionRate.set({ ecosystem: source.ecosystem }, resolved / counts.entriesFetched);
                }
                log.info({ source: source.name, ...counts, llmBatchId }, 'import.source.complete');
            } catch (err) {
                await runs.finish(runId, 'failed', emptyCounts(), { errorSummary: String(err) }).catch(() => {});
                log.error({ source: source.name, err: String(err) }, 'import.source.failed');
            } finally {
                stopTimer();
            }
        }
    } finally {
        await withTimeout(pool.end(), 10_000, 'pg-pool');
        await withTimeout(pushFinalMetrics(obs.registry, 'ontology-importer', `import_${Date.now()}`), 8_000, 'pushgateway');
        await withTimeout(obs.shutdown(), 10_000, 'otel-shutdown');
    }
}

main().then(() => process.exit(0)).catch((err) => { log.error({ err: String(err) }, 'failed'); process.exit(1); });
