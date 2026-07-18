import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { RepositoryProfileEmbeddingsRepository } from '../RepositoryProfileEmbeddingsRepository.js';
import type { ProfileEmbeddingRow } from '../RepositoryProfileEmbeddingsRepository.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256(text: string): string {
    return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Builds a mock pg PoolClient whose `query` is a jest.fn that resolves to
 * `{ rows: [] }` by default.  All transaction boundary calls (BEGIN / COMMIT /
 * ROLLBACK / set_config) resolve the same way so the happy-path completes.
 */
function makeClient(): { client: PoolClient; query: jest.Mock } {
    const query = jest.fn<() => Promise<{ rows: unknown[] }>>().mockResolvedValue({ rows: [] });
    const client = {
        query,
        release: jest.fn(),
    } as unknown as PoolClient;
    return { client, query };
}

function makePool(client: PoolClient): Pool {
    return { connect: jest.fn<() => Promise<PoolClient>>().mockResolvedValue(client) } as unknown as Pool;
}

function row(over: Partial<ProfileEmbeddingRow> = {}): ProfileEmbeddingRow {
    return {
        userId:      'user-1',
        profileId:   'profile-P',
        chunkType:   'description',
        content:     'Some description text',
        contentHash: 'ignored-hash',
        embedding:   [0.1, 0.2, 0.3],
        ...over,
    };
}

// ---------------------------------------------------------------------------
// Derive the scrubbed hash the same way the implementation does (PiiScrubber
// is a no-op for plain text with no PII, so scrubbedContent == content for our
// test fixtures — but we derive it the same way to stay coupled to the real
// implementation rather than hard-coding the value).
// Note: PiiScrubber may redact some patterns.  For these tests we use content
// strings that contain no PII patterns so scrubbed == original.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RepositoryProfileEmbeddingsRepository.upsertBatch – prune superseded rows', () => {
    let client: PoolClient;
    let query: jest.Mock;
    let repo: RepositoryProfileEmbeddingsRepository;

    beforeEach(() => {
        const m = makeClient();
        client  = m.client;
        query   = m.query;
        repo    = new RepositoryProfileEmbeddingsRepository(makePool(client));
    });

    // -----------------------------------------------------------------------
    // Test 0 – demotes to tucaken_app and stamps set_config before the write,
    // inside one BEGIN/COMMIT transaction (RLS ritual via withUserRls)
    // -----------------------------------------------------------------------
    it('demotes to tucaken_app and stamps set_config before the INSERT, inside one BEGIN/COMMIT transaction', async () => {
        await repo.upsertBatch('user-1', [row()]);

        const calls = query.mock.calls as Array<[string, unknown[]?]>;
        const kinds = calls.map(([sql]) => {
            if (/^BEGIN/i.test(sql as string)) return 'BEGIN';
            if (/^SET LOCAL ROLE tucaken_app/i.test(sql as string)) return 'SET_LOCAL_ROLE';
            if (/set_config/.test(sql as string)) return 'set_config';
            if (/INSERT INTO repository_profile_embeddings/i.test(sql as string)) return 'INSERT';
            if (/DELETE FROM repository_profile_embeddings/i.test(sql as string)) return 'DELETE';
            if (/^COMMIT/i.test(sql as string)) return 'COMMIT';
            if (/^ROLLBACK/i.test(sql as string)) return 'ROLLBACK';
            return 'OTHER';
        });

        expect(kinds).toEqual(['BEGIN', 'SET_LOCAL_ROLE', 'set_config', 'INSERT', 'DELETE', 'COMMIT']);

        const setConfigCall = calls[2];
        expect(setConfigCall[0]).toMatch(/SELECT set_config\('app\.current_user_id', \$1, true\)/);
        expect(setConfigCall[1]).toEqual(['user-1']);
    });

    // -----------------------------------------------------------------------
    // Test 1 – DELETE is issued after INSERT with correct params
    // -----------------------------------------------------------------------
    it('issues a DELETE for superseded rows scoped to the batch profile and chunk types', async () => {
        const rows: ProfileEmbeddingRow[] = [
            row({ chunkType: 'one_liner',   content: 'one liner text',   profileId: 'profile-P' }),
            row({ chunkType: 'description', content: 'description text', profileId: 'profile-P' }),
            row({ chunkType: 'highlight',   content: 'highlight text',   profileId: 'profile-P' }),
        ];

        await repo.upsertBatch('user-1', rows);

        // Collect all DELETE calls
        const deleteCalls = (query.mock.calls as Array<[string, unknown[]]>).filter(
            ([sql]) => typeof sql === 'string' && /DELETE FROM repository_profile_embeddings/i.test(sql),
        );

        expect(deleteCalls).toHaveLength(1);

        const [sql, params] = deleteCalls[0];

        // SQL shape
        expect(sql).toMatch(/DELETE FROM repository_profile_embeddings/);
        expect(sql).toMatch(/content_hash <> ALL/);
        expect(sql).toMatch(/chunk_type\s*=\s*ANY/);

        // Params: [profileId, chunkTypes[], scrubbedHashes[]]
        const [profileIdParam, chunkTypesParam, scrubbedHashesParam] = params as [string, string[], string[]];

        expect(profileIdParam).toBe('profile-P');

        // All three chunk types must be in the array (order-insensitive)
        expect([...chunkTypesParam].sort()).toEqual(['description', 'highlight', 'one_liner'].sort());

        // Scrubbed hashes – PiiScrubber is a no-op for our plain-text fixtures
        const expectedHashes = rows.map(r => sha256(r.content)).sort();
        expect([...scrubbedHashesParam].sort()).toEqual(expectedHashes);
    });

    // -----------------------------------------------------------------------
    // Test 2 – 'lifecycle' is never included when no lifecycle row is in batch
    // -----------------------------------------------------------------------
    it('does NOT include "lifecycle" in the chunk_type filter when the batch has no lifecycle row', async () => {
        const rows: ProfileEmbeddingRow[] = [
            row({ chunkType: 'one_liner',   content: 'one liner',   profileId: 'profile-P' }),
            row({ chunkType: 'description', content: 'description', profileId: 'profile-P' }),
        ];

        await repo.upsertBatch('user-1', rows);

        const deleteCalls = (query.mock.calls as Array<[string, unknown[]]>).filter(
            ([sql]) => typeof sql === 'string' && /DELETE FROM repository_profile_embeddings/i.test(sql),
        );

        expect(deleteCalls).toHaveLength(1);

        const [, params] = deleteCalls[0];
        const chunkTypesParam = params[1] as string[];

        expect(chunkTypesParam).not.toContain('lifecycle');
        // Only the types actually present in the batch are targeted
        expect([...chunkTypesParam].sort()).toEqual(['description', 'one_liner'].sort());
    });

    // -----------------------------------------------------------------------
    // Test 3 – batch spanning two profile_ids issues one DELETE per profile
    // -----------------------------------------------------------------------
    it('issues one DELETE per profile_id when the batch spans multiple profiles', async () => {
        const rows: ProfileEmbeddingRow[] = [
            row({ profileId: 'profile-A', chunkType: 'one_liner',   content: 'A one liner'   }),
            row({ profileId: 'profile-A', chunkType: 'description', content: 'A description' }),
            row({ profileId: 'profile-B', chunkType: 'description', content: 'B description' }),
            row({ profileId: 'profile-B', chunkType: 'highlight',   content: 'B highlight'   }),
        ];

        await repo.upsertBatch('user-1', rows);

        const deleteCalls = (query.mock.calls as Array<[string, unknown[]]>).filter(
            ([sql]) => typeof sql === 'string' && /DELETE FROM repository_profile_embeddings/i.test(sql),
        );

        expect(deleteCalls).toHaveLength(2);

        // Collect the profileId param from each DELETE
        const profileIds = deleteCalls.map(([, params]) => (params as unknown[])[0] as string).sort();
        expect(profileIds).toEqual(['profile-A', 'profile-B'].sort());

        // profile-A: types one_liner + description
        const callA = deleteCalls.find(([, p]) => (p as unknown[])[0] === 'profile-A');
        expect(callA).toBeDefined();
        const paramsA = callA![1] as unknown[];
        const typesA = ([...(paramsA[1] as string[])]).sort();
        expect(typesA).toEqual(['description', 'one_liner'].sort());

        // profile-B: types description + highlight
        const callB = deleteCalls.find(([, p]) => (p as unknown[])[0] === 'profile-B');
        expect(callB).toBeDefined();
        const paramsB = callB![1] as unknown[];
        const typesB = ([...(paramsB[1] as string[])]).sort();
        expect(typesB).toEqual(['description', 'highlight'].sort());
    });

    // -----------------------------------------------------------------------
    // Test 4 – empty rows → no DELETE, no INSERT
    // -----------------------------------------------------------------------
    it('issues no queries at all when rows is empty', async () => {
        await repo.upsertBatch('user-1', []);

        expect(query).not.toHaveBeenCalled();
    });
});
