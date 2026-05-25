/** @format */
import { Pool } from 'pg';
import {
    OntologyImportRunRepository, OntologyImportSourceRepository, OntologyWriteRepository,
    OntologyReviewQueueRepository, OntologySkippedImportRepository,
    bootstrapK8sObservability, pushFinalMetrics,
} from '@bedrock/shared';
import type { ImportRunCounts } from '@bedrock/shared';

import { parseEnv } from './env.js';
import { LlmBatchClassifier, parseBatchResult } from './categorization/LlmBatchClassifier.js';

const obs = bootstrapK8sObservability({ serviceName: 'ontology-importer-followup' });
const log = obs.logger;

async function withTimeout(p: Promise<unknown>, ms: number, label: string): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => { timer = setTimeout(() => { log.warn({ label }, 'teardown timed out'); resolve(); }, ms); });
    try { await Promise.race([p.then(() => undefined).catch(() => undefined), timeout]); }
    finally { if (timer) clearTimeout(timer); }
}

/** Split custom_id on the FIRST colon — identifiers (e.g. maven `g:a`) may contain colons. */
function splitCustomId(customId: string): { ecosystem: string; identifier: string } {
    const idx = customId.indexOf(':');
    if (idx < 0) return { ecosystem: '', identifier: customId };
    return { ecosystem: customId.slice(0, idx), identifier: customId.slice(idx + 1) };
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
    const skipped = new OntologySkippedImportRepository(pool);
    const llm = new LlmBatchClassifier(env.anthropicApiKey);

    try {
        const pending = await runs.findPendingBatches();
        log.info({ pending: pending.length }, 'followup.start');

        for (const run of pending) {
            const batch = await llm.retrieve(run.llmBatchId);
            if (batch.processing_status !== 'ended') {
                log.info({ source: run.source, batch: run.llmBatchId, status: batch.processing_status }, 'followup.batch.pending');
                continue;
            }

            const counts = emptyCounts();
            for await (const entry of await llm.results(run.llmBatchId)) {
                if (entry.result.type !== 'succeeded') continue;
                const { ecosystem, identifier } = splitCustomId(entry.custom_id);
                const { decision, category, reasoning } = parseBatchResult(entry.custom_id, entry.result.message);

                if (decision === 'yes' && category) {
                    const canonical = identifier.toLowerCase();
                    const id = await ontology.insertAutoImported(canonical, identifier, category, run.source);
                    await importSources.upsertSeen(id, run.source, identifier, null, {});
                    counts.entriesInserted++;
                } else if (decision === 'no') {
                    await skipped.add({
                        rawName: identifier, ecosystem, source: run.source,
                        llmDecision: 'no', llmReasoning: reasoning ?? null, llmRunId: run.llmBatchId,
                    });
                } else {
                    await reviewQueue.add({
                        rawName: identifier, ecosystem, source: run.source,
                        reason: 'llm_maybe', suggestedCategory: category ?? null, llmReasoning: reasoning ?? null,
                    });
                    counts.reviewQueueAdded++;
                }
            }

            await runs.finish(run.id, 'success', counts, {});
            log.info({ source: run.source, batch: run.llmBatchId, ...counts }, 'followup.batch.complete');
        }
    } finally {
        await withTimeout(pool.end(), 10_000, 'pg-pool');
        await withTimeout(pushFinalMetrics(obs.registry, 'ontology-importer-followup', `followup_${Date.now()}`), 8_000, 'pushgateway');
        await withTimeout(obs.shutdown(), 10_000, 'otel-shutdown');
    }
}

main().then(() => process.exit(0)).catch((err) => { log.error({ err: String(err) }, 'failed'); process.exit(1); });
