/**
 * @format
 * embedBaselineEntries — writes baseline (pre-enrichment) career embeddings
 * for every experience entry at import time.
 *
 * Called immediately after persistCareerEntries so career data is retrievable
 * right after the import reaches 'ready_for_review', without waiting for the
 * user to confirm enrichment.
 *
 * Reuses embedAndPersistEntry with enriched=null, which produces
 * role_description + achievement chunks. Idempotent by content_hash — when
 * run-enrichment later calls the same function with real enriched data the
 * already-stored baseline hashes are skipped and only new enriched chunks are
 * inserted.
 *
 * Non-fatal: a per-entry failure is logged and skipped so a single bad entry
 * cannot prevent the import from reaching ready_for_review.
 *
 * Exported separately from run-import.ts to allow unit testing without
 * bootstrapping the full pipeline module (observability, prom-client, etc.).
 */
import type { Pool } from 'pg';
import type { ExtractedCareerData } from './bedrock/extract-career.js';
import { jobLogger } from '@bedrock/shared';

const log = jobLogger();

export async function embedBaselineEntries(
  pool: Pool,
  region: string,
  userId: string,
  importId: string,
  experienceIds: string[],
  experiences: ExtractedCareerData['experience'],
): Promise<number> {
  const { embedAndPersistEntry } = await import('./embed.js');
  let baseEmbeds = 0;
  for (let i = 0; i < experienceIds.length; i++) {
    try {
      baseEmbeds += await embedAndPersistEntry(
        pool, region, userId, experienceIds[i]!,
        experiences[i]!, null, importId,
      );
    } catch (err) {
      log.warn(
        { event: 'import.baseline_embed_failed', careerEntryId: experienceIds[i], err: (err as Error).message },
        'baseline embed failed (non-fatal)',
      );
    }
  }
  log.info(
    { event: 'import.baseline_embeds', count: baseEmbeds, entries: experienceIds.length },
    'baseline career embeddings written',
  );
  return baseEmbeds;
}
