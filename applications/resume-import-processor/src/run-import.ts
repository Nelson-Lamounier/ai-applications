/**
 * @format
 * Resume import K8s Job entrypoint — runs as a one-shot pod.
 *
 * Pipeline:
 *   Step 1 — Fetch PDF/DOCX from S3
 *   Step 2 — Parse text (pdf-parse or mammoth)
 *   Step 3 — Bedrock structured extraction → ExtractedCareerData
 *   Step 4 — Persist career entries → mark import 'ready_for_review'
 *             (admin-api status polling returns success here)
 *   Step 5 — Per experience entry (background enrichment):
 *             a. Check free-tier enrichment cap (5 entries)
 *             b. Tavily search for role context
 *             c. Bedrock synthesis → EnrichedRoleData
 *             d. Titan embed → insert experience_embeddings
 *             e. Update enrichment_status on career entry
 *   Step 6 — Mark import 'completed'
 *
 * Exit codes:
 *   0 — completed (at least extraction succeeded)
 *   1 — fatal error before any data was written
 *
 * Partial failure (enrichment fails for one role) does not fail the Job.
 * The entry is marked enrichment_status='failed' and the rest continue.
 */
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { Pool } from 'pg';
import { Counter, Histogram } from 'prom-client';
import { bootstrapK8sObservability, pushFinalMetrics } from '@bedrock/shared';
import { parseEnv } from './env.js';

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

const enrichmentEntriesTotal = new Counter({
  name:       'resume_import_enrichment_entries_total',
  help:       'Career entries processed by enrichment outcome.',
  labelNames: ['outcome'] as const,
  registers:  [obs.registry],
});
import { extractTextFromPdf } from './parsers/pdf.js';
import { extractTextFromDocx } from './parsers/docx.js';
import { extractCareerData } from './bedrock/extract-career.js';
import { enrichRole } from './bedrock/enrich-role.js';
import { embedAndPersistEntry } from './embed.js';
import { TavilySearchTool, NoOpSearchTool } from './tools/tavily.js';
import type { ExtractedCareerData, ResumeExperience } from './bedrock/extract-career.js';

const FREE_TIER_ENRICHMENT_CAP = 5;

async function fetchFileFromS3(
  s3: S3Client,
  bucket: string,
  key: string,
): Promise<Buffer> {
  const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const stream = response.Body as NodeJS.ReadableStream;
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

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
    values.push(JSON.stringify(extras.errorDetails));
  }

  values.push(importId);
  await pool.query(
    `UPDATE resume_imports SET ${setParts.join(', ')} WHERE id = $${idx}::uuid`,
    values,
  );
}

async function persistCareerEntries(
  pool: Pool,
  userId: string,
  importId: string,
  data: ExtractedCareerData,
): Promise<string[]> {
  const createdIds: string[] = [];

  const insertEntry = async (
    entryType: string,
    rawData: Record<string, unknown>,
    displayOrder: number,
  ): Promise<string> => {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO user_career_history
             (user_id, import_id, entry_type, raw_data, display_order)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5)
       RETURNING id`,
      [userId, importId, entryType, JSON.stringify(rawData), displayOrder],
    );
    const row = result.rows[0];
    if (!row) throw new Error('persistCareerEntries: INSERT returned no row');
    return row.id;
  };

  for (let i = 0; i < data.experience.length; i++) {
    const id = await insertEntry('experience', data.experience[i] as Record<string, unknown>, i);
    createdIds.push(id);
  }
  for (let i = 0; i < data.education.length; i++) {
    await insertEntry('education', data.education[i] as Record<string, unknown>, i);
  }
  for (const skillGroup of data.skills) {
    await insertEntry('skill', skillGroup as Record<string, unknown>, 0);
  }
  for (let i = 0; i < data.certifications.length; i++) {
    await insertEntry('certification', data.certifications[i] as Record<string, unknown>, i);
  }
  for (let i = 0; i < data.projects.length; i++) {
    await insertEntry('project', data.projects[i] as Record<string, unknown>, i);
  }
  for (let i = 0; i < data.keyAchievements.length; i++) {
    await insertEntry('achievement', data.keyAchievements[i] as Record<string, unknown>, i);
  }

  // Update career_entries_created array on the import record
  await pool.query(
    `UPDATE resume_imports SET career_entries_created = $1 WHERE id = $2::uuid`,
    [createdIds, importId],
  );

  return createdIds;
}

async function countEnrichedEntries(pool: Pool, userId: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM user_career_history
      WHERE user_id = $1::uuid AND entry_type = 'experience' AND enrichment_status = 'complete'`,
    [userId],
  );
  return parseInt(result.rows[0]?.count ?? '0', 10);
}

async function main(): Promise<void> {
  const env = parseEnv();
  const jobStart = process.hrtime.bigint();
  let outcome: 'success' | 'failed' = 'failed';
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

  const searchTool = env.tavilyApiKey
    ? new TavilySearchTool(env.tavilyApiKey)
    : new NoOpSearchTool();

  try {
    // ── Step 1: fetch file from S3 ──────────────────────────────────────────
    await updateImportStatus(pool, env.importId, 'parsing', 'Downloading resume file');
    console.info('[run-import] fetching from S3', { key: env.s3Key });
    const fileBuffer = await fetchFileFromS3(s3, env.assetsBucketName, env.s3Key);

    // ── Step 2: parse text ──────────────────────────────────────────────────
    let rawText: string;
    let extractionMethod: string;

    if (env.contentType === 'application/pdf') {
      const result      = await extractTextFromPdf(fileBuffer, env.s3Key, env.assetsBucketName, env.awsRegion);
      rawText           = result.text;
      extractionMethod  = result.method;
    } else {
      rawText           = await extractTextFromDocx(fileBuffer);
      extractionMethod  = 'mammoth';
    }

    console.info('[run-import] parsed text', { chars: rawText.length, method: extractionMethod });

    // ── Step 3: Bedrock structured extraction ───────────────────────────────
    await updateImportStatus(pool, env.importId, 'extracting_career', 'Extracting career data', {
      rawExtractedText: rawText,
      extractionMethod,
    });

    console.info('[run-import] calling Bedrock for structured extraction');
    const extracted = await extractCareerData(rawText, env.awsRegion);
    console.info('[run-import] extraction complete', {
      experience:  extracted.experience.length,
      education:   extracted.education.length,
      skills:      extracted.skills.length,
    });

    // ── Step 4: persist career entries, signal ready_for_review ────────────
    const experienceIds = await persistCareerEntries(pool, env.userId, env.importId, extracted);

    await updateImportStatus(pool, env.importId, 'ready_for_review', 'Career data extracted', {
      careerEntriesCreated: experienceIds,
    });

    console.info('[run-import] ready_for_review — user can now see extracted data');

    // ── Step 5: per-role enrichment (background) ────────────────────────────
    if (!env.tavilyApiKey) {
      console.info('[run-import] TAVILY_API_KEY absent — skipping enrichment');
    }

    await updateImportStatus(pool, env.importId, 'enriching', 'Researching roles');

    let totalEmbeddings = 0;

    for (let i = 0; i < extracted.experience.length; i++) {
      const exp: ResumeExperience = extracted.experience[i];
      const careerEntryId = experienceIds[i];
      if (!careerEntryId) continue;

      // Check free-tier cap (counts already-enriched entries across all imports)
      const alreadyEnriched = await countEnrichedEntries(pool, env.userId);
      if (alreadyEnriched >= FREE_TIER_ENRICHMENT_CAP) {
        await pool.query(
          `UPDATE user_career_history
              SET enrichment_status = 'skipped',
                  enrichment_skipped_reason = 'free_tier_limit',
                  updated_at = NOW()
            WHERE id = $1::uuid`,
          [careerEntryId],
        );
        console.info('[run-import] free-tier enrichment cap reached, skipping remaining roles', {
          role: exp.title, cap: FREE_TIER_ENRICHMENT_CAP,
        });
        // Still embed without enrichment so basic retrieval works
        const count = await embedAndPersistEntry(
          pool, env.awsRegion, env.userId, careerEntryId, exp, null,
        );
        totalEmbeddings += count;
        continue;
      }

      console.info(`[run-import] enriching role ${i + 1}/${extracted.experience.length}`, {
        title: exp.title, company: exp.company,
      });

      await pool.query(
        `UPDATE user_career_history
            SET enrichment_status = 'enriching', updated_at = NOW()
          WHERE id = $1::uuid`,
        [careerEntryId],
      );

      let enriched = null;
      try {
        enriched = await enrichRole(exp, searchTool, env.awsRegion);
      } catch (err) {
        console.warn('[run-import] enrichment failed for role', { title: exp.title, err });
        await pool.query(
          `UPDATE user_career_history
              SET enrichment_status = 'failed', updated_at = NOW()
            WHERE id = $1::uuid`,
          [careerEntryId],
        );
      }

      if (enriched !== null) {
        await pool.query(
          `UPDATE user_career_history
              SET enrichment_status = 'complete',
                  enriched_data     = $1,
                  updated_at        = NOW()
            WHERE id = $2::uuid`,
          [JSON.stringify(enriched), careerEntryId],
        );
      } else if (enriched === null) {
        // enrichRole returned null (no search results) — mark skipped, still embed
        await pool.query(
          `UPDATE user_career_history
              SET enrichment_status = 'skipped',
                  enrichment_skipped_reason = 'no_search_results',
                  updated_at = NOW()
            WHERE id = $1::uuid`,
          [careerEntryId],
        );
      }

      const count = await embedAndPersistEntry(
        pool, env.awsRegion, env.userId, careerEntryId, exp, enriched,
      );
      totalEmbeddings += count;
    }

    // ── Step 6: completed ───────────────────────────────────────────────────
    await updateImportStatus(pool, env.importId, 'completed', 'Import complete', {
      embeddingsCreatedCount: totalEmbeddings,
      completedAt: new Date(),
    });

    log.info({ totalEmbeddings }, 'completed');
    outcome = 'success';

    await pool.end();
  } catch (err) {
    errorCode = 'PIPELINE_ERROR';
    log.error({ err }, 'fatal error');
    await pool.query(
      `UPDATE resume_imports
          SET status = 'failed',
              error_code = 'PIPELINE_ERROR',
              error_details = $1,
              completed_at = NOW()
        WHERE id = $2::uuid`,
      [JSON.stringify({ message: (err as Error).message }), env.importId],
    ).catch(() => {}); // best-effort — don't mask the original error
    await pool.end().catch(() => {});
  } finally {
    // Record terminal counters BEFORE pushing — these are the ones that
    // matter for Prometheus alerting and dashboards.
    const duration = Number(process.hrtime.bigint() - jobStart) / 1e9;
    importsTotal.inc({ outcome, error_code: errorCode });
    importDurationSeconds.observe({ outcome }, duration);

    // Push final metrics keyed by importId so successive runs replace
    // (Pushgateway groups by URL path = job + groupings).
    await pushFinalMetrics(obs.registry, 'resume-import-processor', env.importId);
    await obs.shutdown();
    process.exit(outcome === 'success' ? 0 : 1);
  }
}

main();
