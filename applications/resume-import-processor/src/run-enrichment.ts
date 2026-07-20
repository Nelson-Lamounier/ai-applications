/**
 * @format
 * Resume enrichment K8s Job entrypoint — runs as a one-shot pod.
 *
 * Dispatched by admin-api ONLY after the user reviews and confirms their
 * extracted career history (resume_imports.status = 'confirmed'). Running
 * after confirmation means enrichment + embeddings are built from corrected
 * data, not the raw extraction the user is about to edit.
 *
 * Pipeline:
 *   Step 1 — Load confirmed experience entries for the import
 *   Step 2 — Per entry: free-tier gate → Tavily → Bedrock → Titan embed
 *            (shared enrichAndEmbedRole — identical logic the import Job
 *             used to run inline)
 *   Step 3 — Mark import 'completed'
 *
 * Exit codes:
 *   0 — completed (enrichment ran; per-role failures are non-fatal)
 *   1 — fatal error before completion (status set to 'failed')
 *
 * Partial failure (enrichment fails for one role) does not fail the Job —
 * the entry is marked enrichment_status='failed' and the rest continue.
 */
import { Pool } from 'pg';
import { Counter, Histogram } from 'prom-client';
import { bootstrapK8sObservability, pushFinalMetrics, PiiScrubber } from '@bedrock/shared';
import {
  embeddingsCreatedTotal,
  seedZeroSeries as seedSubStepSeries,
} from './metrics.js';
import { trace, context, SpanStatusCode } from '@opentelemetry/api';
import { parseEnrichmentEnv } from './env.js';
import { TavilySearchTool, NoOpSearchTool } from './tools/tavily.js';
import { CachedSearchTool } from './tools/tavily-cache.js';
import { enrichAndEmbedRole } from './enrichment.js';
import type { ResumeExperience } from './bedrock/extract-career.js';

const piiScrubber = new PiiScrubber();

const obs = bootstrapK8sObservability({ serviceName: 'resume-enrichment-processor' });
const log = obs.logger;

const enrichmentRunsTotal = new Counter({
  name:       'resume_enrichment_runs_total',
  help:       'Resume enrichment Job runs by terminal outcome.',
  labelNames: ['outcome', 'error_code'] as const,
  registers:  [obs.registry],
});

const enrichmentDurationSeconds = new Histogram({
  name:       'resume_enrichment_duration_seconds',
  help:       'End-to-end enrichment Job duration in seconds.',
  labelNames: ['outcome'] as const,
  buckets:    [1, 5, 15, 30, 60, 120, 300, 600],
  registers:  [obs.registry],
});

const enrichmentEntriesTotal = new Counter({
  name:       'resume_import_enrichment_entries_total',
  help:       'Career entries processed by enrichment outcome.',
  labelNames: ['outcome'] as const,
  registers:  [obs.registry],
});

for (const outcome of ['success', 'failed'] as const) {
  enrichmentRunsTotal.inc({ outcome, error_code: '' }, 0);
  enrichmentDurationSeconds.observe({ outcome }, 0);
}
for (const outcome of ['success', 'skipped', 'failed'] as const) {
  enrichmentEntriesTotal.inc({ outcome }, 0);
}
seedSubStepSeries();

const tracer = trace.getTracer('resume-import-processor');

interface ExperienceRow {
  id:       string;
  raw_data: ResumeExperience;
}

async function loadExperienceEntries(
  pool: Pool,
  importId: string,
  userId: string,
): Promise<ExperienceRow[]> {
  const result = await pool.query<ExperienceRow>(
    `SELECT id, raw_data
       FROM user_career_history
      WHERE import_id = $1::uuid
        AND user_id   = $2::uuid
        AND entry_type = 'experience'
      ORDER BY display_order, created_at`,
    [importId, userId],
  );
  return result.rows;
}

async function updateImportStatus(
  pool: Pool,
  importId: string,
  status: string,
  currentStep: string,
  extras?: { embeddingsCreatedCount?: number; completedAt?: Date; errorDetails?: unknown },
): Promise<void> {
  const setParts = ['status = $1', 'current_step = $2', 'updated_at = NOW()'];
  const values: unknown[] = [status, currentStep];
  let idx = 3;
  if (extras?.embeddingsCreatedCount !== undefined) {
    setParts.push(`embeddings_created_count = $${idx++}`);
    values.push(extras.embeddingsCreatedCount);
  }
  if (extras?.completedAt !== undefined) {
    setParts.push(`completed_at = $${idx++}`);
    values.push(extras.completedAt);
  }
  if (extras?.errorDetails !== undefined) {
    setParts.push(`error_details = $${idx++}`);
    values.push(piiScrubber.scrub(JSON.stringify(extras.errorDetails)).redacted);
  }
  values.push(importId);
  await pool.query(
    `UPDATE resume_imports SET ${setParts.join(', ')} WHERE id = $${idx}::uuid`,
    values,
  );
}

async function main(): Promise<void> {
  const env = parseEnrichmentEnv();
  const jobStart = process.hrtime.bigint();
  let outcome = 'failed';
  let errorCode = '';

  log.info({ importId: env.importId, userId: env.userId }, 'starting enrichment');

  const pool = new Pool({
    host:              env.pg.host,
    port:              env.pg.port,
    database:          env.pg.database,
    user:              env.pg.user,
    password:          env.pg.password,
    max:               5,
    idleTimeoutMillis: 30_000,
    ssl:               false,
  });

  // NoOp returns [] (never cached) so wrapping it adds nothing; only wrap
  // the live Tavily tool in the Postgres cache (migration 017).
  const searchTool = env.tavilyApiKey
    ? new CachedSearchTool(new TavilySearchTool(env.tavilyApiKey), pool)
    : new NoOpSearchTool();

  if (!env.tavilyApiKey) {
    log.info({}, 'TAVILY_API_KEY absent — roles will be embedded without enrichment');
  }

  const rootSpan = tracer.startSpan('resume_enrichment.pipeline', {
    attributes: { 'user.id': env.userId, 'import.id': env.importId },
  }, obs.parentContext);

  try {
    await context.with(trace.setSpan(obs.parentContext, rootSpan), async () => {
      await updateImportStatus(pool, env.importId, 'enriching', 'Researching roles');

      const entries = await loadExperienceEntries(pool, env.importId, env.userId);
      rootSpan.setAttribute('entries.count', entries.length);

      let totalEmbeddings = 0;
      for (let i = 0; i < entries.length; i++) {
        const row = entries[i];
        if (!row) continue;
        const { embeddings, outcome: roleOutcome } = await enrichAndEmbedRole({
          pool,
          region:        env.awsRegion,
          userId:        env.userId,
          importId:      env.importId,
          searchTool,
          log,
          exp:           row.raw_data,
          careerEntryId: row.id,
          roleIndex:     i,
        });
        totalEmbeddings += embeddings;
        enrichmentEntriesTotal.inc({ outcome: roleOutcome });
      }

      await updateImportStatus(pool, env.importId, 'completed', 'Enrichment complete', {
        embeddingsCreatedCount: totalEmbeddings,
        completedAt:            new Date(),
      });
      embeddingsCreatedTotal().inc(totalEmbeddings);
      log.info({ totalEmbeddings, entries: entries.length }, 'completed');
      outcome = 'success';
      await pool.end();
    });
  } catch (err) {
    errorCode = 'ENRICHMENT_ERROR';
    rootSpan.recordException(err instanceof Error ? err : new Error(String(err)));
    rootSpan.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
    log.error({ err }, 'fatal error');
    await pool
      .query(
        `UPDATE resume_imports
            SET status = 'failed',
                error_code = 'ENRICHMENT_ERROR',
                error_details = $1,
                completed_at = NOW()
          WHERE id = $2::uuid`,
        [JSON.stringify({ message: piiScrubber.scrub((err as Error).message).redacted }), env.importId],
      )
      .catch(() => {});
    await pool.end().catch(() => {});
  } finally {
    rootSpan.end();
    const { traceId } = rootSpan.spanContext();
    const duration = Number(process.hrtime.bigint() - jobStart) / 1e9;
    enrichmentRunsTotal.inc({ outcome, error_code: errorCode });
    enrichmentDurationSeconds.observe({ outcome }, duration);
    log.info({
      event:      'resume_enrichment.complete',
      status:     outcome === 'success' ? 'complete' : 'error',
      trace_id:   traceId,
      user_id:    env.userId,
      import_id:  env.importId,
      duration_s: duration,
    }, outcome === 'success' ? 'complete' : 'error');
    // Bounded key: userId, never per-import importId — enrichment variant (see pushgateway.ts).
    await pushFinalMetrics(obs.registry, 'resume-enrichment-processor', env.userId);
    await obs.shutdown();
    process.exit(outcome === 'success' ? 0 : 1);
  }
}

main();
