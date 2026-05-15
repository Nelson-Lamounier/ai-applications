/**
 * @format
 * Shared per-role enrichment + embedding unit.
 *
 * Extracted so both entrypoints can reuse it:
 *   - run-import.ts      no longer enriches (stops at ready_for_review).
 *   - run-enrichment.ts  runs this per experience entry after the user
 *                        confirms their reviewed career history.
 *
 * One call = one experience entry: free-tier gate → Tavily research →
 * Bedrock synthesis → status write → Titan embeddings. Throwing inside a
 * single role must not abort the others, so callers wrap each invocation
 * in its own span/try and treat a thrown error as that role's failure only.
 */
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { recordBedrockCost } from '@bedrock/shared';
import { enrichRole } from './bedrock/enrich-role.js';
import type { EnrichedRoleData } from './bedrock/enrich-role.js';
import type { ResumeExperience } from './bedrock/extract-career.js';
import { embedAndPersistEntry } from './embed.js';
import type { WebSearchTool } from './tools/tavily.js';
import { freeTierCappedTotal } from './metrics.js';

export const FREE_TIER_ENRICHMENT_CAP = 5;

const tracer = trace.getTracer('resume-import-processor');

/** Count enriched 'experience' entries for a user across ALL imports.
 *  Used to enforce the free-tier cap; it is intentionally global so a user
 *  can't bypass the cap by importing multiple resumes. */
export async function countEnrichedEntries(pool: Pool, userId: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM user_career_history
      WHERE user_id = $1::uuid AND entry_type = 'experience' AND enrichment_status = 'complete'`,
    [userId],
  );
  return Number.parseInt(result.rows[0]?.count ?? '0', 10);
}

export type RoleEnrichmentOutcome = 'success' | 'skipped' | 'failed';

export interface EnrichRoleArgs {
  pool:          Pool;
  region:        string;
  userId:        string;
  importId:      string;
  searchTool:    WebSearchTool;
  log:           Pick<Logger, 'info' | 'warn'>;
  exp:           ResumeExperience;
  careerEntryId: string;
  roleIndex:     number;
}

/**
 * Enrich + embed a single experience entry. Returns the number of embedding
 * rows written and the outcome. Never throws for an enrichment failure — the
 * role is marked enrichment_status='failed' and embeddings still run so basic
 * retrieval works without enriched context.
 */
export async function enrichAndEmbedRole(
  args: EnrichRoleArgs,
): Promise<{ embeddings: number; outcome: RoleEnrichmentOutcome }> {
  const { pool, region, userId, importId, searchTool, log, exp, careerEntryId, roleIndex } = args;

  return tracer.startActiveSpan('resume_import.enrich_role', {
    attributes: { 'role.title': exp.title, 'role.company': exp.company, 'role.index': roleIndex },
  }, async (span): Promise<{ embeddings: number; outcome: RoleEnrichmentOutcome }> => {
    let outcome: RoleEnrichmentOutcome = 'success';
    try {
      // Free-tier cap — counts already-enriched entries across all imports.
      const alreadyEnriched = await countEnrichedEntries(pool, userId);
      if (alreadyEnriched >= FREE_TIER_ENRICHMENT_CAP) {
        span.setAttribute('enrich.skipped_reason', 'free_tier_limit');
        freeTierCappedTotal().inc();
        await pool.query(
          `UPDATE user_career_history
              SET enrichment_status = 'skipped',
                  enrichment_skipped_reason = 'free_tier_limit',
                  updated_at = NOW()
            WHERE id = $1::uuid`,
          [careerEntryId],
        );
        // Still embed without enrichment so basic retrieval works.
        const count = await embedAndPersistEntry(
          pool, region, userId, careerEntryId, exp, null, importId,
        );
        return { embeddings: count, outcome: 'skipped' };
      }

      await pool.query(
        `UPDATE user_career_history
            SET enrichment_status = 'enriching', updated_at = NOW()
          WHERE id = $1::uuid`,
        [careerEntryId],
      );

      let enriched: EnrichedRoleData | null = null;
      let enrichThrew = false;
      try {
        const enrichResult = await enrichRole(exp, searchTool, region, log as Logger);
        enriched = enrichResult.data;
        if (enrichResult.inputTokens > 0) {
          recordBedrockCost(pool, {
            userId,
            modelId:      process.env['ENRICHMENT_MODEL_ID'] ?? 'eu.anthropic.claude-haiku-4-5-20251001-v1:0',
            pipeline:     'resume-import',
            inputTokens:  enrichResult.inputTokens,
            outputTokens: enrichResult.outputTokens,
            importId,
          }).catch((err) => log.warn({ err }, '[cost] enrich-role cost record failed (non-fatal)'));
        }
      } catch (err) {
        enrichThrew = true;
        span.recordException(err instanceof Error ? err : new Error(String(err)));
        span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
        await pool.query(
          `UPDATE user_career_history
              SET enrichment_status = 'failed', updated_at = NOW()
            WHERE id = $1::uuid`,
          [careerEntryId],
        );
      }

      // Mutually exclusive status writes: failed (catch above) | complete | skipped.
      if (enrichThrew) {
        log.warn({ careerEntryId }, 'enrichment threw, status=failed already written');
        outcome = 'failed';
      } else if (enriched !== null) {
        await pool.query(
          `UPDATE user_career_history
              SET enrichment_status = 'complete',
                  enriched_data     = $1,
                  updated_at        = NOW()
            WHERE id = $2::uuid`,
          [JSON.stringify(enriched), careerEntryId],
        );
      } else {
        await pool.query(
          `UPDATE user_career_history
              SET enrichment_status = 'skipped',
                  enrichment_skipped_reason = 'no_search_results',
                  updated_at = NOW()
            WHERE id = $1::uuid`,
          [careerEntryId],
        );
        outcome = 'skipped';
      }

      const count = await embedAndPersistEntry(
        pool, region, userId, careerEntryId, exp, enriched, importId,
      );
      return { embeddings: count, outcome };
    } catch (err) {
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
      return { embeddings: 0, outcome: 'failed' };
    } finally {
      span.end();
    }
  });
}
