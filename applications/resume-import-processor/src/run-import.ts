/**
 * @format
 * Resume import K8s Job entrypoint — runs as a one-shot pod.
 *
 * This Job covers extraction only. Enrichment + embeddings were split into
 * the resume-enrichment Job (run-enrichment.ts), dispatched by admin-api
 * after the user confirms their reviewed career history.
 *
 * Pipeline:
 *   Step 1 — Fetch PDF/DOCX from S3
 *   Step 2 — Parse text (pdf-parse or mammoth)
 *   Step 3 — Bedrock structured extraction → ExtractedCareerData
 *   Step 4 — Persist career entries → mark import 'ready_for_review'
 *             (admin-api status polling returns success here; the pod exits)
 *
 * Exit codes:
 *   0 — extraction succeeded, status is ready_for_review
 *   1 — fatal error before any data was written
 */
import { S3Client } from '@aws-sdk/client-s3';
import { Pool } from 'pg';
import { Counter, Histogram } from 'prom-client';
import { bootstrapK8sObservability, pushFinalMetrics, recordBedrockCost, PiiScrubber } from '@bedrock/shared';
import {
  careerEntriesTotal,
  seedZeroSeries as seedSubStepSeries,
} from './metrics.js';
import { trace, context, SpanStatusCode } from '@opentelemetry/api';
import { parseEnv } from './env.js';
import { extractTextFromPdf } from './parsers/pdf.js';
import { extractTextFromDocx } from './parsers/docx.js';
import { extractCareerData } from './bedrock/extract-career.js';
import type { ExtractedCareerData } from './bedrock/extract-career.js';
import { TavilySearchTool, NoOpSearchTool } from './tools/tavily.js';
import { CachedSearchTool } from './tools/tavily-cache.js';
import { fanOutRoleSearches, type FanoutRole } from './tools/tavily-fanout.js';
import { generateGapAnalysis, type GapAnalysisRole } from './bedrock/gap-analysis.js';
import { embedBaselineEntries } from './baseline-embed.js';
import {
  DEFAULT_MAX_RESUME_FILE_BYTES,
  fetchFileFromS3,
  loadResumeImportFileMetadata,
  resolveSupportedResumeContentType,
  type SupportedResumeFileKind,
} from './file-intake.js';
import { persistCareerEntries } from './career-persistence.js';

const piiScrubber = new PiiScrubber();

// One-shot K8s Job — bootstrap observability before any AWS / pg client
// loads so OTel auto-instrumentation picks them up. Metrics push to
// Pushgateway in `finally` because the pod dies before scrape.
const obs = bootstrapK8sObservability({ serviceName: 'resume-import-processor' });
const log = obs.logger;

const importsTotal = new Counter({
  name:       'resume_import_runs_total',
  help:       'Resume import Job runs by terminal outcome.',
  labelNames: ['outcome', 'error_code'] as const,
  registers:  [obs.registry],
});

const importDurationSeconds = new Histogram({
  name:       'resume_import_duration_seconds',
  help:       'End-to-end Job duration in seconds.',
  labelNames: ['outcome'] as const,
  buckets:    [1, 5, 15, 30, 60, 120, 300, 600],
  registers:  [obs.registry],
});

const stepDurationSeconds = new Histogram({
  name:       'resume_import_step_duration_seconds',
  help:       'Per-pipeline-step duration in seconds.',
  labelNames: ['step'] as const,
  buckets:    [0.1, 0.5, 1, 5, 15, 30, 60, 120],
  registers:  [obs.registry],
});

// Seed zero-valued series so Grafana panels render "0" instead of "No data"
// when Pushgateway is fresh (it has no on-disk persistence) or when no Job has
// pushed yet in the dashboard's [24h] window. inc(…, 0) / observe(…, 0)
// register the TimeSeries without changing the count.
for (const outcome of ['success', 'failed'] as const) {
  importsTotal.inc({ outcome, error_code: '' }, 0);
  importDurationSeconds.observe({ outcome }, 0);
}
for (const step of ['extract', 'parse', 'persist'] as const) {
  stepDurationSeconds.observe({ step }, 0);
}
// Seed the new sub-step series (textract, tavily, bedrock, embed, persist, …).
seedSubStepSeries();

const tracer = trace.getTracer('resume-import-processor');

async function updateImportStatus(
  pool: Pool,
  importId: string,
  status: string,
  currentStep: string,
  extras?: Record<string, unknown>,
): Promise<void> {
  const setParts = ['status = $1', 'current_step = $2', 'updated_at = NOW()'];
  const values: unknown[] = [status, currentStep];
  let idx = 3;

  if (extras?.rawExtractedText !== undefined) {
    setParts.push(`raw_extracted_text = $${idx++}`);
    values.push(extras.rawExtractedText);
  }
  if (extras?.extractionMethod !== undefined) {
    setParts.push(`extraction_method = $${idx++}`);
    values.push(extras.extractionMethod);
  }
  if (extras?.careerEntriesCreated !== undefined) {
    setParts.push(`career_entries_created = $${idx++}`);
    values.push(extras.careerEntriesCreated);
  }
  if (extras?.embeddingsCreatedCount !== undefined) {
    setParts.push(`embeddings_created_count = $${idx++}`);
    values.push(extras.embeddingsCreatedCount);
  }
  if (extras?.completedAt !== undefined) {
    setParts.push(`completed_at = $${idx++}`);
    values.push(extras.completedAt);
  }
  if (extras?.errorCode !== undefined) {
    setParts.push(`error_code = $${idx++}`);
    values.push(extras.errorCode);
  }
  if (extras?.errorDetails !== undefined) {
    setParts.push(`error_details = $${idx++}`);
    values.push(piiScrubber.scrub(JSON.stringify(extras.errorDetails)).redacted);
  }

  values.push(importId);
  const { persistDurationSeconds } = await import('./metrics.js');
  const stop = persistDurationSeconds().startTimer({ op: 'update_status' });
  await pool.query(
    `UPDATE resume_imports SET ${setParts.join(', ')} WHERE id = $${idx}::uuid`,
    values,
  );
  stop();
}

async function main(): Promise<void> {
  const env = parseEnv();
  const jobStart = process.hrtime.bigint();
  let outcome: string = 'failed';
  let errorCode = '';

  log.info({
    importId:    env.importId,
    userId:      env.userId,
    s3Key:       env.s3Key,
    contentType: env.contentType,
  }, 'starting');

  const pool = new Pool({
    host:               env.pg.host,
    port:               env.pg.port,
    database:           env.pg.database,
    user:               env.pg.user,
    password:           env.pg.password,
    max:                5,
    idleTimeoutMillis:  30_000,
    ssl:                false,
  });

  const s3 = new S3Client({ region: env.awsRegion });

  const rootSpan = tracer.startSpan('resume_import.pipeline', {
    attributes: {
      'user.id':   env.userId,
      'import.id': env.importId,
    },
  }, obs.parentContext);

  try {
    await context.with(trace.setSpan(obs.parentContext, rootSpan), async () => {

      // ── Step 1: fetch file from S3 ────────────────────────────────────────
      let fileBuffer!: Buffer;
      let resumeFileKind!: SupportedResumeFileKind;
      await tracer.startActiveSpan('resume_import.fetch', async (span) => {
        try {
          await updateImportStatus(pool, env.importId, 'parsing', 'Downloading resume file');
          const importFile = await loadResumeImportFileMetadata(pool, env.importId);
          const contentType = importFile.contentType ?? env.contentType;
          resumeFileKind = resolveSupportedResumeContentType(contentType);
          if (importFile.contentType && env.contentType) {
            const envFileKind = resolveSupportedResumeContentType(env.contentType);
            if (envFileKind !== resumeFileKind) {
              throw new Error(`resume_content_type_mismatch: env=${env.contentType} db=${importFile.contentType}`);
            }
          }
          fileBuffer = await fetchFileFromS3(s3, env.assetsBucketName, env.s3Key, {
            maxBytes:          DEFAULT_MAX_RESUME_FILE_BYTES,
            expectedSizeBytes: importFile.fileSizeBytes,
          });
          span.setAttribute('s3.key', env.s3Key);
          span.setAttribute('resume.file_kind', resumeFileKind);
          if (importFile.fileSizeBytes !== undefined) span.setAttribute('resume.file_size_bytes', importFile.fileSizeBytes);
        } catch (err) {
          span.recordException(err instanceof Error ? err : new Error(String(err)));
          span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
          throw err;
        } finally { span.end(); }
      });

      // ── Step 2: parse text ────────────────────────────────────────────────
      let rawText = '';
      let extractionMethod = '';
      await tracer.startActiveSpan('resume_import.parse', async (span) => {
        const stopStep = stepDurationSeconds.startTimer({ step: 'parse' });
        try {
          if (resumeFileKind === 'pdf') {
            const result     = await extractTextFromPdf(fileBuffer, env.s3Key, env.assetsBucketName, env.awsRegion);
            rawText          = result.text;
            extractionMethod = result.method;
          } else {
            rawText          = await extractTextFromDocx(fileBuffer);
            extractionMethod = 'mammoth';
          }
          span.setAttributes({ 'parse.chars': rawText.length, 'parse.method': extractionMethod });
        } catch (err) {
          span.recordException(err instanceof Error ? err : new Error(String(err)));
          span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
          throw err;
        } finally { stopStep(); span.end(); }
      });

      // ── Step 3: Bedrock structured extraction ─────────────────────────────
      let extracted!: ExtractedCareerData;
      await tracer.startActiveSpan('resume_import.extract_roles', async (span) => {
        const stopStep = stepDurationSeconds.startTimer({ step: 'extract' });
        try {
          await updateImportStatus(pool, env.importId, 'extracting_career', 'Extracting career data', {
            rawExtractedText: rawText,
            extractionMethod,
          });
          const extractionResult = await extractCareerData(rawText, env.awsRegion);
          extracted = extractionResult.data;
          await recordBedrockCost(pool, {
            userId:      env.userId,
            modelId:     process.env['EXTRACTION_MODEL_ID'] ?? 'eu.anthropic.claude-haiku-4-5-20251001-v1:0',
            pipeline:    'resume-import',
            inputTokens:  extractionResult.inputTokens,
            outputTokens: extractionResult.outputTokens,
            importId:    env.importId,
          }).catch((err) => log.warn({ err }, '[cost] extract-career cost record failed (non-fatal)'));
          span.setAttributes({
            'roles.count':     extracted.experience.length,
            'education.count': extracted.education.length,
          });
          careerEntriesTotal().inc({ type: 'experience' }, extracted.experience.length);
          careerEntriesTotal().inc({ type: 'education' },  extracted.education.length);
        } catch (err) {
          span.recordException(err instanceof Error ? err : new Error(String(err)));
          span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
          throw err;
        } finally { stopStep(); span.end(); }
      });

      // ── Step 4: persist career entries ───────────────────────────────────
      let experienceIds!: string[];
      let allEntryIds!: string[];
      await tracer.startActiveSpan('resume_import.save_entries', async (span) => {
        const stopStep = stepDurationSeconds.startTimer({ step: 'persist' });
        try {
          const persisted = await persistCareerEntries(pool, env.userId, env.importId, extracted);
          experienceIds = persisted.experienceIds;
          allEntryIds = persisted.allEntryIds;
          await updateImportStatus(pool, env.importId, 'analyzing', 'Analyzing your experience', {
            careerEntriesCreated: allEntryIds,
          });
          span.setAttribute('entries.saved', allEntryIds.length);
        } catch (err) {
          span.recordException(err instanceof Error ? err : new Error(String(err)));
          span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
          throw err;
        } finally { stopStep(); span.end(); }
      });

      // ── Step 4b: baseline embeddings ─────────────────────────────────────
      // Career data is retrievable immediately after import, not only once the
      // user confirms enrichment. Non-fatal — a failed embed must not prevent
      // the import reaching ready_for_review.
      await tracer.startActiveSpan('resume_import.baseline_embed', async (span) => {
        try {
          const region = process.env['AWS_REGION'] ?? process.env['BEDROCK_REGION'] ?? 'eu-west-1';
          const baseEmbeds = await embedBaselineEntries(
            pool, region, env.userId, env.importId, experienceIds, extracted.experience,
          );
          span.setAttribute('baseline_embeds.count', baseEmbeds);
        } catch (err) {
          // embedBaselineEntries already logs per-entry failures; this catches
          // any unexpected throw from the helper itself.
          span.recordException(err instanceof Error ? err : new Error(String(err)));
          span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
          log.warn({ err }, 'baseline embed step failed (non-fatal)');
        } finally { span.end(); }
      });

      // ── Step 5: gap analysis (fan-out → Bedrock → persist report) ────────
      // Non-fatal: any failure here leaves gap_report NULL and the import
      // still reaches ready_for_review — the review screen must work without
      // a report. The fan-out caps to the most-recent roles; the count of
      // skipped roles is surfaced in the report's freeTierLimit.
      await tracer.startActiveSpan('resume_import.gap_analysis', async (span) => {
        try {
          const searchTool = env.tavilyApiKey
            ? new CachedSearchTool(new TavilySearchTool(env.tavilyApiKey), pool)
            : new NoOpSearchTool();

          const fanoutRoles: FanoutRole[] = extracted.experience.map((exp, i) => ({
            roleId:  experienceIds[i]!,
            company: exp.company,
            title:   exp.title,
            period:  exp.period,
          }));

          const { outcomes } = await fanOutRoleSearches(fanoutRoles, searchTool, log);
          const ctxByRole = new Map(
            outcomes.map((o) => [o.roleId, o.status === 'ok' ? o.results : null]),
          );
          const rolesSkipped = outcomes.filter((o) => o.status === 'skipped_budget').length;

          const gapRoles: GapAnalysisRole[] = extracted.experience.map((exp, i) => ({
            roleId:        experienceIds[i]!,
            experience:    exp,
            publicContext: ctxByRole.get(experienceIds[i]!) ?? null,
          }));

          const gap = await generateGapAnalysis(gapRoles, rolesSkipped, env.awsRegion);
          await recordBedrockCost(pool, {
            userId:       env.userId,
            modelId:      process.env['GAP_ANALYSIS_MODEL_ID'] ?? 'eu.anthropic.claude-haiku-4-5-20251001-v1:0',
            pipeline:     'resume-import',
            inputTokens:  gap.inputTokens,
            outputTokens: gap.outputTokens,
            importId:     env.importId,
          }).catch((err) => log.warn({ err }, '[cost] gap-analysis cost record failed (non-fatal)'));

          await pool.query(
            `UPDATE resume_imports
                SET gap_report = $1::jsonb,
                    gap_report_generated_at = NOW(),
                    updated_at = NOW()
              WHERE id = $2::uuid`,
            [JSON.stringify({ report: gap.data, groundingMetadata: gap.groundingMetadata ?? [], verifiedAt: new Date().toISOString() }), env.importId],
          );
          span.setAttribute('gap.roles', gap.data.perRole.length);
        } catch (err) {
          // Non-fatal — log and continue to ready_for_review without a report.
          span.recordException(err instanceof Error ? err : new Error(String(err)));
          span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
          log.warn({ err }, 'gap analysis failed (non-fatal) — review will render without a report');
        } finally { span.end(); }
      });

      // Pipeline ends here. Enrichment + embeddings are deferred to the
      // resume-enrichment Job, dispatched by admin-api only after the user
      // reviews and confirms their extracted career history.
      await updateImportStatus(pool, env.importId, 'ready_for_review', 'Career data extracted');
      log.info({ entries: allEntryIds.length, experience_entries: experienceIds.length }, 'ready_for_review');
      outcome = 'success';

      await pool.end();
    });

  } catch (err) {
    errorCode = 'PIPELINE_ERROR';
    rootSpan.recordException(err instanceof Error ? err : new Error(String(err)));
    rootSpan.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
    log.error({ err }, 'fatal error');
    await pool.query(
      `UPDATE resume_imports
          SET status = 'failed',
              error_code = 'PIPELINE_ERROR',
              error_details = $1,
              completed_at = NOW()
        WHERE id = $2::uuid`,
      [JSON.stringify({ message: piiScrubber.scrub((err as Error).message).redacted }), env.importId],
    ).catch(() => {}); // best-effort — don't mask the original error
    await pool.end().catch(() => {});
  } finally {
    rootSpan.end();
    const { traceId } = rootSpan.spanContext();

    // Record terminal counters BEFORE pushing — these are the ones that
    // matter for Prometheus alerting and dashboards.
    const duration = Number(process.hrtime.bigint() - jobStart) / 1e9;
    importsTotal.inc({ outcome, error_code: errorCode });
    importDurationSeconds.observe({ outcome }, duration);

    // Structured completion log — Loki filters on trace_id to join log stream with Tempo.
    log.info({
      event:      'resume_import.complete',
      status:     outcome === 'success' ? 'complete' : 'error',
      trace_id:   traceId,
      user_id:    env.userId,
      import_id:  env.importId,
      duration_s: duration,
    }, outcome === 'success' ? 'complete' : 'error');

    // Push final metrics keyed by importId so successive runs replace
    // (Pushgateway groups by URL path = job + groupings).
    await pushFinalMetrics(obs.registry, 'resume-import-processor', env.importId);
    await obs.shutdown();
    process.exit(outcome === 'success' ? 0 : 1);
  }
}

main();
