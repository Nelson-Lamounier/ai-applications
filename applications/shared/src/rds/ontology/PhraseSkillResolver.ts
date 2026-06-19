/** @format */
import type { IEmbeddingProvider } from '../interfaces/IEmbeddingProvider.js';
import type { SkillEmbeddingResolver } from './SkillEmbeddingResolver.js';

/**
 * Phrase -> canonical skill resolver: embeds a free-text skill phrase (Titan)
 * and maps it to its nearest canonical via SkillEmbeddingResolver, or null when
 * nothing clears the similarity floor (the caller keeps the raw phrase).
 *
 * This is the fuzzy second stage behind the enricher's exact-alias map — it
 * collapses the descriptive long tail ("auto scaling group configuration" ->
 * "aws auto scaling") that exact matching cannot. Sub-slice C of the
 * external-taxonomy alignment: the wiring that finally makes the embedding
 * resolver load-bearing in the enrich path.
 *
 * Memoised per instance: the same phrase recurs across many chunks in a repo
 * (thousands of chunks, far fewer distinct phrases), so each distinct phrase is
 * embedded + queried at most once per Job — turning a per-chunk cost into a
 * per-distinct-phrase one. Null (a known miss) is cached too, so an unresolvable
 * phrase is never re-queried.
 */
export class PhraseSkillResolver {
    private readonly cache = new Map<string, string | null>();

    constructor(
        private readonly embedder: IEmbeddingProvider,
        private readonly resolver: SkillEmbeddingResolver,
    ) {}

    /** @returns the nearest canonical skill for `phrase`, or null. */
    async resolve(phrase: string): Promise<string | null> {
        const cached = this.cache.get(phrase);
        if (cached !== undefined) return cached;

        const vector = await this.embedder.embed(phrase);
        const match = await this.resolver.resolveByVector(vector);
        const canonical = match?.canonical ?? null;
        this.cache.set(phrase, canonical);
        return canonical;
    }
}
