/**
 * @format
 * Embedding writer — generates Titan embeddings and inserts into
 * experience_embeddings for a single career entry.
 *
 * Called once per career entry after enrichment completes (or is skipped).
 * Chunks the entry into typed semantic slices so retrieval can weight
 * different aspects differently when composing resume sections.
 *
 * Chunk types produced:
 *   role_description         — what the role was (title + company + period)
 *   enriched_responsibilities — Tavily-enriched typical duties (if enriched)
 *   transferable_skills      — soft/transferable skills (if enriched)
 *   industry_context         — sector/company context (if enriched)
 *   achievement              — one chunk per highlights[] bullet
 */
import crypto from 'node:crypto';
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';
import type { Pool } from 'pg';
import type { ResumeExperience } from './bedrock/extract-career.js';
import type { EnrichedRoleData } from './bedrock/enrich-role.js';
import { recordBedrockCost, PiiScrubber } from '@bedrock/shared';

const piiScrubber = new PiiScrubber();

const TITAN_MODEL_ID = 'amazon.titan-embed-text-v2:0';
const EMBEDDING_DIM  = parseInt(process.env['EMBEDDING_DIMENSION'] ?? '1024', 10);

async function embedText(client: BedrockRuntimeClient, text: string): Promise<{ embedding: number[]; inputTokens: number }> {
  const command = new InvokeModelCommand({
    modelId:     TITAN_MODEL_ID,
    contentType: 'application/json',
    accept:      'application/json',
    body: Buffer.from(JSON.stringify({
      inputText:  text,
      dimensions: EMBEDDING_DIM,
      normalize:  true,
    })),
  });
  const response = await client.send(command);
  const parsed   = JSON.parse(Buffer.from(response.body).toString('utf-8'));
  return {
    embedding:   parsed.embedding as number[],
    inputTokens: parsed.inputTextTokenCount ?? 0,
  };
}

interface EmbedChunk {
  chunkType: string;
  content:   string;
  metadata:  Record<string, unknown>;
}

function buildChunks(
  experience: ResumeExperience,
  enriched: EnrichedRoleData | null,
): EmbedChunk[] {
  const base = { company: experience.company, title: experience.title, period: experience.period };
  const chunks: EmbedChunk[] = [];

  // Always embed a role description chunk
  chunks.push({
    chunkType: 'role_description',
    content:   `${experience.title} at ${experience.company} (${experience.period})`,
    metadata:  base,
  });

  // One chunk per achievement bullet
  for (const highlight of experience.highlights) {
    chunks.push({
      chunkType: 'achievement',
      content:   piiScrubber.scrub(highlight).redacted,
      metadata:  base,
    });
  }

  if (!enriched) return chunks;

  if (enriched.responsibilities.length > 0) {
    chunks.push({
      chunkType: 'enriched_responsibilities',
      content:   enriched.responsibilities.join('\n'),
      metadata:  { ...base, careerLevel: enriched.careerLevel },
    });
  }

  if (enriched.transferableSkills.length > 0) {
    chunks.push({
      chunkType: 'transferable_skills',
      content:   enriched.transferableSkills.join(', '),
      metadata:  base,
    });
  }

  if (enriched.industryContext) {
    chunks.push({
      chunkType: 'industry_context',
      content:   enriched.industryContext,
      metadata:  { ...base, typicalTechStack: enriched.typicalTechStack },
    });
  }

  return chunks;
}

/**
 * Embeds all chunks for an experience entry and inserts into experience_embeddings.
 * Returns the number of rows inserted.
 */
export async function embedAndPersistEntry(
  pool: Pool,
  bedrockRegion: string,
  userId: string,
  careerEntryId: string,
  experience: ResumeExperience,
  enriched: EnrichedRoleData | null,
  importId: string,
): Promise<number> {
  const { embedDurationSeconds, persistDurationSeconds } = await import('./metrics.js');
  const client = new BedrockRuntimeClient({ region: bedrockRegion });
  const chunks = buildChunks(experience, enriched);
  let inserted = 0;

  for (const chunk of chunks) {
    const contentHash = crypto.createHash('sha256').update(chunk.content).digest('hex');

    // Skip if identical chunk already exists (idempotent re-runs)
    const exists = await pool.query<{ id: string }>(
      `SELECT id FROM experience_embeddings
        WHERE career_entry_id = $1::uuid AND content_hash = $2`,
      [careerEntryId, contentHash],
    );
    if (exists.rows[0]) continue;

    const stopEmbed = embedDurationSeconds().startTimer();
    const { embedding, inputTokens } = await embedText(client, chunk.content);
    stopEmbed();

    recordBedrockCost(pool, {
      userId,
      modelId:      TITAN_MODEL_ID,
      pipeline:     'resume-import',
      inputTokens,
      outputTokens: 0,
      importId,
    }).catch((err) => console.warn('[embed] cost record failed (non-fatal)', err));

    const stopInsert = persistDurationSeconds().startTimer({ op: 'insert_embedding' });
    await pool.query(
      `INSERT INTO experience_embeddings
             (user_id, career_entry_id, chunk_type, content, content_hash, embedding, metadata)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::vector, $7)`,
      [
        userId,
        careerEntryId,
        chunk.chunkType,
        chunk.content,
        contentHash,
        JSON.stringify(embedding),
        JSON.stringify(chunk.metadata),
      ],
    );
    stopInsert();
    inserted++;
  }

  return inserted;
}
