/** @format */
import type { Pool, PoolClient } from 'pg';
import type { ExtractedCareerData } from './bedrock/extract-career.js';

/**
 * Career-entry persistence with replace-by-identity reconciliation.
 *
 * Invariant: user_career_history holds ONE logical career record per user.
 * A re-imported resume must not accumulate duplicate entries alongside the
 * rows a previous import created (the loader reads every row for the user,
 * with no import filter). Within one transaction this module:
 *
 *   1. deletes rows from THIS import_id (a retried job re-creates cleanly),
 *   2. deletes rows from ANY prior import whose identity matches an incoming
 *      entry (the new upload wins for entries it contains; entries the new
 *      resume omits are preserved),
 *   3. inserts the incoming entries,
 *   4. records created experience ids on resume_imports.
 *
 * Identity is type-specific (company+title, degree+institution, name,
 * category, achievement text), normalised identically in TS and SQL:
 * lowercase, trimmed, internal whitespace collapsed.
 */

const NORM_SQL = (expr: string): string =>
  `regexp_replace(lower(btrim(coalesce(${expr}, ''))), '\\s+', ' ', 'g')`;

const IDENTITY_SQL: Record<string, string> = {
  experience: `${NORM_SQL("raw_data->>'company'")} || '|' || ${NORM_SQL("raw_data->>'title'")}`,
  education: `${NORM_SQL("raw_data->>'degree'")} || '|' || ${NORM_SQL("raw_data->>'institution'")}`,
  certification: NORM_SQL("raw_data->>'name'"),
  skill: NORM_SQL("raw_data->>'category'"),
  project: NORM_SQL("raw_data->>'name'"),
  achievement: NORM_SQL("raw_data->>'achievement'"),
};

function norm(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase().replace(/\s+/g, ' ') : '';
}

/**
 * Normalised identity key for a career entry, mirroring IDENTITY_SQL.
 * Returns null when every identity field is blank -- a null key is never
 * used for deletion, so a garbled entry can only add a row, not wipe one.
 */
export function careerIdentityKey(
  entryType: string,
  rawData: Record<string, unknown>,
): string | null {
  let key: string;
  switch (entryType) {
    case 'experience':
      key = `${norm(rawData['company'])}|${norm(rawData['title'])}`;
      break;
    case 'education':
      key = `${norm(rawData['degree'])}|${norm(rawData['institution'])}`;
      break;
    case 'certification':
      key = norm(rawData['name']);
      break;
    case 'skill':
      key = norm(rawData['category']);
      break;
    case 'project':
      key = norm(rawData['name']);
      break;
    case 'achievement':
      key = norm(rawData['achievement']);
      break;
    default:
      return null;
  }
  return key.replace(/\|/g, '') === '' ? null : key;
}

interface TypedEntry {
  entryType: string;
  rawData: Record<string, unknown>;
  displayOrder: number;
}

function flattenEntries(data: ExtractedCareerData): TypedEntry[] {
  const entries: TypedEntry[] = [];
  data.experience.forEach((e, i) =>
    entries.push({ entryType: 'experience', rawData: e as unknown as Record<string, unknown>, displayOrder: i }));
  data.education.forEach((e, i) =>
    entries.push({ entryType: 'education', rawData: e as unknown as Record<string, unknown>, displayOrder: i }));
  data.skills.forEach(e =>
    entries.push({ entryType: 'skill', rawData: e as unknown as Record<string, unknown>, displayOrder: 0 }));
  data.certifications.forEach((e, i) =>
    entries.push({ entryType: 'certification', rawData: e as unknown as Record<string, unknown>, displayOrder: i }));
  data.projects.forEach((e, i) =>
    entries.push({ entryType: 'project', rawData: e as unknown as Record<string, unknown>, displayOrder: i }));
  data.keyAchievements.forEach((e, i) =>
    entries.push({ entryType: 'achievement', rawData: e as unknown as Record<string, unknown>, displayOrder: i }));
  return entries;
}

async function reconcileAndInsert(
  client: PoolClient,
  userId: string,
  importId: string,
  entries: TypedEntry[],
): Promise<string[]> {
  const { persistDurationSeconds } = await import('./metrics.js');

  // 1. Retry idempotency: a re-run of this import starts from a clean slate.
  const stopRetry = persistDurationSeconds().startTimer({ op: 'reconcile_career' });
  await client.query(
    `DELETE FROM user_career_history WHERE user_id = $1::uuid AND import_id = $2::uuid`,
    [userId, importId],
  );

  // 2. Replace-by-identity: prior imports' rows matching an incoming entry go.
  const keysByType = new Map<string, string[]>();
  for (const entry of entries) {
    const key = careerIdentityKey(entry.entryType, entry.rawData);
    if (key === null) continue;
    const keys = keysByType.get(entry.entryType) ?? [];
    keys.push(key);
    keysByType.set(entry.entryType, keys);
  }
  for (const [entryType, keys] of keysByType) {
    const identitySql = IDENTITY_SQL[entryType];
    if (!identitySql) continue;
    await client.query(
      `DELETE FROM user_career_history
        WHERE user_id = $1::uuid AND entry_type = $2 AND ${identitySql} = ANY($3::text[])`,
      [userId, entryType, keys],
    );
  }
  stopRetry();

  // 3. Insert the incoming entries.
  const experienceIds: string[] = [];
  for (const entry of entries) {
    const stop = persistDurationSeconds().startTimer({ op: 'insert_career' });
    const result = await client.query<{ id: string }>(
      `INSERT INTO user_career_history
             (user_id, import_id, entry_type, raw_data, display_order)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5)
       RETURNING id`,
      [userId, importId, entry.entryType, JSON.stringify(entry.rawData), entry.displayOrder],
    );
    stop();
    const row = result.rows[0];
    if (!row) throw new Error('persistCareerEntries: INSERT returned no row');
    if (entry.entryType === 'experience') experienceIds.push(row.id);
  }

  // 4. Track created experience rows on the import record.
  await client.query(
    `UPDATE resume_imports SET career_entries_created = $1 WHERE id = $2::uuid`,
    [experienceIds, importId],
  );

  return experienceIds;
}

/**
 * Persist extracted career entries for an import, transactionally and
 * idempotently. Returns the created experience row ids (the contract
 * resume_imports.career_entries_created promises).
 */
export async function persistCareerEntries(
  pool: Pool,
  userId: string,
  importId: string,
  data: ExtractedCareerData,
): Promise<string[]> {
  const entries = flattenEntries(data);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const experienceIds = await reconcileAndInsert(client, userId, importId, entries);
    await client.query('COMMIT');
    return experienceIds;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
