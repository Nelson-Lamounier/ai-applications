/** @format */
import { Pool } from 'pg';
import {
    OntologyImportRunRepository, OntologyImportSourceRepository, OntologyWriteRepository,
    OntologyReviewQueueRepository, OntologySkippedImportRepository,
    bootstrapK8sObservability, pushFinalMetrics,
} from '@bedrock/shared';
import type { ImportRunCounts } from '@bedrock/shared';

import { parseEnv } from './env.js';
import { BedrockBatchClassifier, parseModelOutput } from './categorization/BedrockBatchClassifier.js';

const obs = bootstrapK8sObservability({ serviceName: 'ontology-importer-followup' });
const log = obs.logger;

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
    const skipped = new OntologySkippedImportRepository(pool);
    const llm = new BedrockBatchClassifier({
        region: env.bedrock.region, bucket: env.bedrock.bucket, prefix: env.bedrock.prefix,
        roleArn: env.bedrock.roleArn, modelId: env.bedrock.modelId,
    });

    try {
        const pending = await runs.findPendingBatches();
        log.info({ pending: pending.length }, 'followup.start');

        for (const run of pending) {
            const { status } = await llm.retrieve(run.llmBatchId);
            if (status !== 'Completed' && status !== 'PartiallyCompleted') {
                if (status === 'Failed' || status === 'Stopped' || status === 'Expired') {
                    await runs.finish(run.id, 'failed', emptyCounts(), { errorSummary: `batch ${status}` }).catch(() => {});
                    log.warn({ batch: run.llmBatchId, status }, 'followup.batch.failed');
                } else {
                    log.info({ batch: run.llmBatchId, status }, 'followup.batch.pending');
                }
                continue;
            }

            const counts = emptyCounts();
            let recordErrors = 0;
            for await (const record of llm.readResults(run.runKey)) {
                try {
                    const { decision, category, reasoning } = parseModelOutput(record);
                    const mapped = run.recordMap[record.recordId];
                    if (!mapped) { log.warn({ recordId: record.recordId }, 'followup.unmapped_record'); continue; }
                    const { ecosystem, identifier } = mapped;

                    if (decision === 'yes' && category) {
                        const id = await ontology.insertAutoImported(identifier.toLowerCase(), identifier, category, 'pooled_llm_batch');
                        await importSources.upsertSeen(id, 'pooled_llm_batch', identifier, null, {});
                        counts.entriesInserted++;
                    } else if (decision === 'no') {
                        await skipped.add({ rawName: identifier, ecosystem, source: 'pooled_llm_batch', llmDecision: 'no', llmReasoning: reasoning ?? null, llmRunId: run.llmBatchId });
                    } else {
                        await reviewQueue.add({ rawName: identifier, ecosystem, source: 'pooled_llm_batch', reason: 'llm_maybe', suggestedCategory: category ?? null, llmReasoning: reasoning ?? null });
                        counts.reviewQueueAdded++;
                    }
                } catch (err) {
                    // One bad record (DB constraint violation, parse failure, transient pg error)
                    // must NOT abort the whole batch routing. Log + count; continue. The pooled
                    // run still finishes 'success'; the unrouted record stays unrouted and will
                    // be re-pooled by the next monthly import.
                    recordErrors++;
                    log.warn({ recordId: record.recordId, err: String(err) }, 'followup.record_failed');
                }
            }
            if (recordErrors > 0) log.warn({ batch: run.llmBatchId, recordErrors }, 'followup.record_errors');

            await runs.finish(run.id, 'success', counts, {});
            log.info({ batch: run.llmBatchId, ...counts }, 'followup.batch.complete');
        }
    } finally {
        await withTimeout(pool.end(), 10_000, 'pg-pool');
        await withTimeout(pushFinalMetrics(obs.registry, 'ontology-importer-followup', `followup_${Date.now()}`), 8_000, 'pushgateway');
        await withTimeout(obs.shutdown(), 10_000, 'otel-shutdown');
    }
}

main().then(() => process.exit(0)).catch((err) => { log.error({ err: String(err) }, 'failed'); process.exit(1); });
