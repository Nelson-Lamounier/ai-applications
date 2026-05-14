import type { Pool } from 'pg';
import {
    PgVectorRetriever,
    TitanEmbeddingProvider,
    expandQuery,
    type RetrievedPassage,
} from '@bedrock/shared';

const TOP_K   = 8;
const embedder = TitanEmbeddingProvider.fromEnvironment();

function deduplicatePassages(passages: RetrievedPassage[]): RetrievedPassage[] {
    const seen = new Set<string>();
    return passages.filter((p) => {
        const key = `${p.sourceUri}::${p.text.slice(0, 100)}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

export async function multiQueryRetrieve(
    userId:       string,
    userQuestion: string,
    pool:         Pool,
): Promise<RetrievedPassage[]> {
    const retriever = new PgVectorRetriever(pool, embedder);
    const opts      = { maxProfiles: 5, maxChunks: 8, profileWeight: 1.5 };

    const [q2, q3]      = expandQuery(userQuestion);
    const [r1, r2, r3] = await Promise.all([
        retriever.retrieve(userId, userQuestion, opts),
        retriever.retrieve(userId, q2,           opts),
        retriever.retrieve(userId, q3,           opts),
    ]);

    return deduplicatePassages(
        [...r1, ...r2, ...r3].sort((a, b) => b.score - a.score),
    ).slice(0, TOP_K);
}
