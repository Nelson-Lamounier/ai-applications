/**
 * @format
 * RdsOAuthConnectionsRepository — unit tests
 *
 * Follows the codebase pattern (see RdsSyncStateRepository.test.ts): inject a
 * fake pg Pool that captures SQL + params, plus an in-memory KmsEnvelope fake
 * that base64-round-trips the payload. Assert on captured SQL strings, params,
 * and envelope call shape — no real Postgres, no real KMS.
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { RdsOAuthConnectionsRepository } from './RdsOAuthConnectionsRepository.js';
import type { KmsEnvelope, EncryptedPayload } from '../../crypto/index.js';
import * as logger from '../../logger.js';
import * as emf    from '../../emf.js';
import { IntegrityError } from '../../crypto/index.js';

// ---------- fakes ----------

interface Call { sql: string; params: unknown[] }

function fakePool(responses: Array<{ rows: unknown[] }> = []) {
    const calls: Call[] = [];
    let i = 0;
    return {
        calls,
        query: jest.fn(async (sql: string, params: unknown[]) => {
            calls.push({ sql, params });
            return responses[i++] ?? { rows: [] };
        }),
    };
}

function fakeEnvelope(): KmsEnvelope & { encryptCalls: Array<{ pt: string; ctx?: Record<string,string> }>; decryptCalls: Array<{ p: EncryptedPayload; ctx?: Record<string,string> }> } {
    const encryptCalls: Array<{ pt: string; ctx?: Record<string,string> }> = [];
    const decryptCalls: Array<{ p: EncryptedPayload; ctx?: Record<string,string> }> = [];
    return {
        encryptCalls,
        decryptCalls,
        async encrypt(pt, ctx) {
            encryptCalls.push({ pt, ctx });
            return {
                ciphertext: Buffer.from(`ct:${pt}`),
                dek:        Buffer.from('dek'),
                iv:         Buffer.alloc(12, 1),
                tag:        Buffer.alloc(16, 2),
            };
        },
        async decrypt(p, ctx) {
            decryptCalls.push({ p, ctx });
            return p.ciphertext.toString('utf8').replace(/^ct:/, '');
        },
    };
}

function newRepo(pool: ReturnType<typeof fakePool>, env: ReturnType<typeof fakeEnvelope>) {
    // Cast through unknown — the fake pool implements only `query` of the Pool surface.
    return new RdsOAuthConnectionsRepository({ pool: pool as unknown as never, envelope: env });
}

// ---------- shared row helper ----------

function rowFixture(overrides: Partial<Record<string, unknown>> = {}) {
    return {
        id:                       'row-1',
        user_id:                  'u1',
        provider:                 'github',
        provider_user_id:         '42',
        username:                 'octocat',
        access_token_enc:         null,
        access_token_ciphertext:  Buffer.from('ct:tok'),
        access_token_dek:         Buffer.from('dek'),
        access_token_iv:          Buffer.alloc(12, 1),
        access_token_tag:         Buffer.alloc(16, 2),
        scopes:                   ['repo'],
        installation_id:          '999',
        connected_at:             new Date('2026-01-01T00:00:00Z'),
        revoked_at:               null,
        suspended_at:             null,
        ...overrides,
    };
}

// ---------- tests ----------

describe('RdsOAuthConnectionsRepository.upsert', () => {
    it('encrypts then inserts 4 bytea columns with EncryptionContext bound to {user_id, provider}', async () => {
        const pool = fakePool([{ rows: [rowFixture()] }]);
        const env = fakeEnvelope();
        const repo = newRepo(pool, env);

        const c = await repo.upsert({
            userId: 'u1', provider: 'github',
            providerUserId: '42', username: 'octocat',
            accessToken: 'tok', scopes: ['repo'], installationId: '999',
        });

        // Envelope called with the right plaintext + context.
        expect(env.encryptCalls).toEqual([{ pt: 'tok', ctx: { user_id: 'u1', provider: 'github' } }]);

        // SQL writes the new bytea columns and NOT the legacy column.
        const ins = pool.calls.find(x => x.sql.includes('INSERT INTO oauth_connections'))!;
        expect(ins).toBeDefined();
        expect(ins.sql).toContain('access_token_ciphertext');
        expect(ins.sql).toContain('access_token_dek');
        expect(ins.sql).toContain('access_token_iv');
        expect(ins.sql).toContain('access_token_tag');
        expect(ins.sql).not.toMatch(/INSERT INTO oauth_connections[^)]*access_token_enc/);

        // ON CONFLICT updates the envelope cols + clears revoked/suspended.
        expect(ins.sql).toMatch(/ON CONFLICT \(user_id, provider\) DO UPDATE/);
        expect(ins.sql).toMatch(/revoked_at\s*=\s*NULL/);
        expect(ins.sql).toMatch(/suspended_at\s*=\s*NULL/);

        // Params carry the encrypted blob from the envelope.
        expect(ins.params.slice(0, 4)).toEqual(['u1', 'github', '42', 'octocat']);
        expect((ins.params[4] as Buffer).toString('utf8')).toBe('ct:tok');
        expect(ins.params[5]).toEqual(Buffer.from('dek'));
        expect(ins.params[8]).toEqual(['repo']);
        expect(ins.params[9]).toBe('999');

        // Returned model carries plaintext, not ciphertext.
        expect(c.accessToken).toBe('tok');
        expect(c.installationId).toBe('999');
    });
});

describe('RdsOAuthConnectionsRepository.getByUserAndProvider', () => {
    it('decrypts envelope columns and returns plaintext token', async () => {
        const pool = fakePool([{ rows: [rowFixture()] }]);
        const env = fakeEnvelope();
        const repo = newRepo(pool, env);

        const got = await repo.getByUserAndProvider('u1', 'github');

        expect(pool.calls[0]!.sql).toMatch(/SELECT \* FROM oauth_connections WHERE user_id = \$1 AND provider = \$2/);
        expect(pool.calls[0]!.params).toEqual(['u1', 'github']);
        expect(env.decryptCalls[0]!.ctx).toEqual({ user_id: 'u1', provider: 'github' });
        expect(got?.accessToken).toBe('tok');
    });

    it('returns null when no row found', async () => {
        const repo = newRepo(fakePool([{ rows: [] }]), fakeEnvelope());
        const got = await repo.getByUserAndProvider('u1', 'github');
        expect(got).toBeNull();
    });
});

describe('RdsOAuthConnectionsRepository.getByInstallationId', () => {
    it('queries on installation_id and returns plaintext', async () => {
        const pool = fakePool([{ rows: [rowFixture({ installation_id: 'inst-42' })] }]);
        const env = fakeEnvelope();
        const repo = newRepo(pool, env);

        const got = await repo.getByInstallationId('inst-42');
        expect(pool.calls[0]!.sql).toMatch(/WHERE installation_id = \$1/);
        expect(pool.calls[0]!.params).toEqual(['inst-42']);
        expect(got?.accessToken).toBe('tok');
    });

    it('returns null on miss', async () => {
        const repo = newRepo(fakePool([{ rows: [] }]), fakeEnvelope());
        expect(await repo.getByInstallationId('missing')).toBeNull();
    });
});

describe('RdsOAuthConnectionsRepository dual-read transition', () => {
    it('falls back to plaintext access_token_enc when envelope columns are NULL', async () => {
        const row = rowFixture({
            access_token_ciphertext: null,
            access_token_dek:        null,
            access_token_iv:         null,
            access_token_tag:        null,
            access_token_enc:        'legacy-plaintext',
        });
        const pool = fakePool([{ rows: [row] }]);
        const env = fakeEnvelope();
        const repo = newRepo(pool, env);

        const got = await repo.getByUserAndProvider('u1', 'github');
        expect(got?.accessToken).toBe('legacy-plaintext');
        // Envelope decrypt should NOT have been called for the legacy row.
        expect(env.decryptCalls).toHaveLength(0);
    });

    it('throws when a row has neither envelope nor plaintext material', async () => {
        const row = rowFixture({
            access_token_ciphertext: null,
            access_token_dek:        null,
            access_token_iv:         null,
            access_token_tag:        null,
            access_token_enc:        null,
        });
        const pool = fakePool([{ rows: [row] }]);
        const repo = newRepo(pool, fakeEnvelope());
        await expect(repo.getByUserAndProvider('u1', 'github')).rejects.toThrow(/no token material/);
    });
});

describe('RdsOAuthConnectionsRepository.markRevoked / markSuspended', () => {
    it('writes revoked_at via UPDATE', async () => {
        const pool = fakePool();
        const repo = newRepo(pool, fakeEnvelope());
        const t = new Date('2026-01-02T03:04:05Z');
        await repo.markRevoked('row-1', t);
        expect(pool.calls[0]!.sql).toMatch(/UPDATE oauth_connections SET revoked_at = \$2 WHERE id = \$1/);
        expect(pool.calls[0]!.params).toEqual(['row-1', t]);
    });

    it('writes suspended_at via UPDATE', async () => {
        const pool = fakePool();
        const repo = newRepo(pool, fakeEnvelope());
        const t = new Date('2026-01-02T03:04:05Z');
        await repo.markSuspended('row-1', t);
        expect(pool.calls[0]!.sql).toMatch(/UPDATE oauth_connections SET suspended_at = \$2 WHERE id = \$1/);
        expect(pool.calls[0]!.params).toEqual(['row-1', t]);
    });
});

describe('RdsOAuthConnectionsRepository observability', () => {
    let logSpy: ReturnType<typeof jest.spyOn>;
    let emfSpy: ReturnType<typeof jest.spyOn>;

    beforeEach(() => {
        logSpy = jest.spyOn(logger, 'log').mockImplementation(() => undefined);
        emfSpy = jest.spyOn(emf,    'emitEmfMetric').mockImplementation(() => undefined);
    });

    afterEach(() => {
        logSpy.mockRestore();
        emfSpy.mockRestore();
    });

    it('upsert emits oauth.token.encrypt log with outcome=success', async () => {
        const pool = fakePool([{ rows: [rowFixture()] }]);
        const env  = fakeEnvelope();
        const repo = newRepo(pool, env);

        await repo.upsert({
            userId: 'u1', provider: 'github',
            providerUserId: '42', username: 'octocat',
            accessToken: 'tok', scopes: [], installationId: null,
        });

        const call = logSpy.mock.calls.find((c: unknown[]) => c[1] === 'oauth.token.encrypt');
        expect(call).toBeDefined();
        expect(call![0]).toBe('INFO');
        expect(call![2]).toMatchObject({
            userId:   'u1',
            provider: 'github',
            outcome:  'success',
        });
        expect(typeof (call![2] as Record<string, unknown>)['durationMs']).toBe('number');
    });

    it('getByUserAndProvider on envelope columns emits oauth.token.decrypt log with outcome=success', async () => {
        const pool = fakePool([{ rows: [rowFixture()] }]);
        const env  = fakeEnvelope();
        const repo = newRepo(pool, env);

        await repo.getByUserAndProvider('u1', 'github');

        const call = logSpy.mock.calls.find((c: unknown[]) => c[1] === 'oauth.token.decrypt');
        expect(call).toBeDefined();
        expect(call![2]).toMatchObject({ outcome: 'success' });
    });

    it('legacy plaintext fallback logs outcome=legacy_plaintext at INFO', async () => {
        const row = rowFixture({
            access_token_ciphertext: null,
            access_token_dek:        null,
            access_token_iv:         null,
            access_token_tag:        null,
            access_token_enc:        'legacy',
        });
        const pool = fakePool([{ rows: [row] }]);
        const repo = newRepo(pool, fakeEnvelope());

        await repo.getByUserAndProvider('u1', 'github');

        const call = logSpy.mock.calls.find((c: unknown[]) => c[1] === 'oauth.token.decrypt');
        expect(call![0]).toBe('INFO');
        expect(call![2]).toMatchObject({ outcome: 'legacy_plaintext' });
        expect(emfSpy).not.toHaveBeenCalled();
    });

    it('decrypt IntegrityError emits ERROR log AND an OAuthTokenDecryptFailures metric', async () => {
        const row = rowFixture();
        const pool = fakePool([{ rows: [row] }]);
        const envBase = fakeEnvelope();
        const env = {
            ...envBase,
            decrypt: jest.fn(async () => { throw new IntegrityError(); }),
        };
        const repo = newRepo(pool, env as typeof envBase);

        await expect(repo.getByUserAndProvider('u1', 'github')).rejects.toBeInstanceOf(IntegrityError);

        expect(emfSpy).toHaveBeenCalledTimes(1);
        const [namespace, dims, metrics, props] = emfSpy.mock.calls[0]! as [string, Record<string, string>, Array<{ name: string; value: number; unit: string }>, Record<string, unknown>];
        expect(namespace).toBe('Portfolio/OAuth');
        expect(dims).toEqual({ Environment: expect.any(String) });
        expect(metrics).toEqual([{ name: 'OAuthTokenDecryptFailures', value: 1, unit: 'Count' }]);
        expect(props).toMatchObject({ userId: 'u1', provider: 'github', errorClass: 'IntegrityError' });

        const decryptLog = logSpy.mock.calls.find((c: unknown[]) => c[1] === 'oauth.token.decrypt');
        expect(decryptLog![0]).toBe('ERROR');
        expect(decryptLog![2]).toMatchObject({ outcome: 'integrity_error' });
    });

    it('decrypt KMS failure (non-Integrity) emits metric with errorClass and outcome=kms_error', async () => {
        const row = rowFixture();
        const pool = fakePool([{ rows: [row] }]);
        const envBase = fakeEnvelope();
        const env = {
            ...envBase,
            decrypt: jest.fn(async () => { throw new Error('kms boom'); }),
        };
        const repo = newRepo(pool, env as typeof envBase);

        await expect(repo.getByUserAndProvider('u1', 'github')).rejects.toThrow(/kms boom/);

        const [, , metrics, props] = emfSpy.mock.calls[0]! as [string, Record<string, string>, Array<{ name: string; value: number; unit: string }>, Record<string, unknown>];
        expect(metrics[0]!.name).toBe('OAuthTokenDecryptFailures');
        expect(props).toMatchObject({ errorClass: 'Error' });

        const decryptLog = logSpy.mock.calls.find((c: unknown[]) => c[1] === 'oauth.token.decrypt');
        expect(decryptLog![2]).toMatchObject({ outcome: 'kms_error' });
    });
});
