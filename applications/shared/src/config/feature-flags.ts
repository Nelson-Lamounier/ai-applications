/**
 * @format
 * Feature flag wrapper over the `app_config` table.
 *
 * `app_config` is a key/value JSONB store seeded by ops. Each flag stores
 * a JSON document of the shape:
 *
 *   { "enabled": boolean, "rollout": number, "deny_users": uuid[], "allow_users": uuid[] }
 *
 * `rollout` is a percentile in [0, 1]; a user is considered in-bucket when
 * `hash(userId, key) / 2^32 < rollout`. `allow_users` and `deny_users`
 * override the rollout calculation: deny first, then allow, then percentile.
 *
 * Missing key → disabled. Missing or malformed value → disabled.
 * Errors against the database → disabled (fail-closed); callers should not
 * have to add their own try/catch.
 *
 * Results are cached per-process for `FEATURE_FLAG_TTL_MS` (default 60s) so
 * a long-running K8s Job doesn't hammer the database. The cache is keyed by
 * `${flagKey}::${userId ?? '__global__'}` and stores the boolean only.
 */
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';

interface FeatureFlagValue {
    readonly enabled?:     boolean;
    readonly rollout?:     number;
    readonly deny_users?:  readonly string[];
    readonly allow_users?: readonly string[];
}

interface CacheEntry {
    readonly value:      boolean;
    readonly cachedAtMs: number;
}

const TTL_MS = parseInt(process.env.FEATURE_FLAG_TTL_MS ?? '60000', 10);

const cache = new Map<string, CacheEntry>();

function isCacheFresh(entry: CacheEntry): boolean {
    return Date.now() - entry.cachedAtMs < TTL_MS;
}

/**
 * Hash a (userId, key) pair into a uniform [0, 1) bucket. Used so the same
 * user lands in the same bucket across pod restarts and across services.
 */
function userBucket(userId: string, key: string): number {
    const hash = createHash('sha256').update(`${userId}::${key}`).digest();
    // Read the first 4 bytes as an unsigned 32-bit int.
    const intVal =
        (hash[0] << 24 >>> 0) |
        (hash[1] << 16) |
        (hash[2] << 8)  |
        hash[3];
    // Coerce to unsigned and divide by 2^32 to land in [0, 1).
    return (intVal >>> 0) / 0x1_0000_0000;
}

function evaluate(value: FeatureFlagValue, userId: string | undefined, key: string): boolean {
    if (value.enabled !== true) return false;

    if (userId) {
        if (value.deny_users?.includes(userId)) return false;
        if (value.allow_users?.includes(userId)) return true;
    }

    const rollout = typeof value.rollout === 'number'
        ? Math.max(0, Math.min(1, value.rollout))
        : 1;
    if (rollout >= 1) return true;
    if (rollout <= 0) return false;
    if (!userId) return false; // No user → cannot bucket → conservative deny.

    return userBucket(userId, key) < rollout;
}

/**
 * Returns `true` iff the feature is enabled for the given user. Any failure
 * (missing key, malformed JSON, database error) resolves to `false` and is
 * logged at warn level.
 */
export async function isFeatureEnabled(
    pool: Pool,
    key: string,
    userId?: string,
): Promise<boolean> {
    const cacheKey = `${key}::${userId ?? '__global__'}`;
    const cached = cache.get(cacheKey);
    if (cached && isCacheFresh(cached)) return cached.value;

    let value = false;
    try {
        const r = await pool.query<{ value: FeatureFlagValue }>(
            `SELECT value FROM app_config WHERE key = $1`,
            [key],
        );
        if (r.rows[0]) value = evaluate(r.rows[0].value, userId, key);
    } catch (err) {
         
        console.warn(`isFeatureEnabled(${key}) failed; defaulting to false`, err);
        value = false;
    }

    cache.set(cacheKey, { value, cachedAtMs: Date.now() });
    return value;
}

/**
 * Drop cached entries. Calling with no args clears everything; with a
 * `key` alone clears every per-user variant of that key; with both clears
 * exactly one slot. Used by `upsertFeatureFlag` so callers don't see
 * stale values right after an update.
 */
export function clearFeatureFlagCache(key?: string, userId?: string): void {
    if (key === undefined) {
        cache.clear();
        return;
    }
    if (userId !== undefined) {
        cache.delete(`${key}::${userId}`);
        return;
    }
    const prefix = `${key}::`;
    for (const cacheKey of cache.keys()) {
        if (cacheKey.startsWith(prefix)) cache.delete(cacheKey);
    }
}

/**
 * Seed a feature-flag row. Test/migration helper — do not call from request
 * paths. Uses INSERT … ON CONFLICT so callers can reset to a known state.
 */
export async function upsertFeatureFlag(
    pool: Pool,
    key: string,
    value: FeatureFlagValue,
): Promise<void> {
    await pool.query(
        `INSERT INTO app_config (key, value)
         VALUES ($1, $2::jsonb)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [key, JSON.stringify(value)],
    );
    clearFeatureFlagCache(key);
}
