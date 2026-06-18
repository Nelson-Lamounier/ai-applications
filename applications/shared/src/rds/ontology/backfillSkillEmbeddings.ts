/** @format */
import type { SkillOntologyRepository } from '../implementations/SkillOntologyRepository.js';
import type { IEmbeddingProvider } from '../interfaces/IEmbeddingProvider.js';

export interface BackfillSkillEmbeddingsOptions {
    /** Rows fetched per batch. Default 100. */
    readonly batchSize?: number;
    /** Hard cap on rows embedded this run (cost guard). Default: unbounded. */
    readonly max?: number;
}

/**
 * Embed every canonical skill that lacks a vector (migration 094) with the same
 * Titan provider the chunk pipeline uses, so a free-text phrase can later be
 * resolved to its nearest canonical (SkillEmbeddingResolver). Sub-slice B of the
 * external-taxonomy alignment: the reusable engine the taxonomy import (ESCO)
 * feeds — it embeds whatever vocabulary is in skill_ontology, today the seed,
 * tomorrow the full import.
 *
 * Drains in bounded batches and is idempotent: an already-embedded skill is not
 * re-fetched (the query filters `embedding IS NULL`), so re-running only fills
 * gaps. Embeds the canonical_name (the skill's preferred label) — the same text
 * a resolver embeds a phrase against.
 *
 * @returns the number of skills embedded this run.
 */
export async function backfillSkillEmbeddings(
    repo: SkillOntologyRepository,
    embedder: IEmbeddingProvider,
    opts: BackfillSkillEmbeddingsOptions = {},
): Promise<number> {
    const batchSize = opts.batchSize ?? 100;
    let embedded = 0;

    for (;;) {
        const remaining = opts.max ? opts.max - embedded : batchSize;
        if (remaining <= 0) break;
        const batch = await repo.loadCanonicalsNeedingEmbedding(Math.min(batchSize, remaining));
        if (batch.length === 0) break;

        for (const skill of batch) {
            const vector = await embedder.embed(skill.canonicalName);
            await repo.updateEmbedding(skill.id, vector);
            embedded++;
        }
    }
    return embedded;
}
