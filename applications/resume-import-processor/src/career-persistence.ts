/**
 * @format
 */
import type { Pool, PoolClient } from 'pg';
import type { ExtractedCareerData } from './bedrock/extract-career.js';

export interface PersistedCareerEntries {
  allEntryIds: string[];
  experienceIds: string[];
}

async function insertCareerEntry(
  client: PoolClient,
  userId: string,
  importId: string,
  entryType: string,
  rawData: Record<string, unknown>,
  displayOrder: number,
): Promise<string> {
  const { persistDurationSeconds } = await import('./metrics.js');
  const stop = persistDurationSeconds().startTimer({ op: 'insert_career' });
  try {
    const result = await client.query<{ id: string }>(
      `INSERT INTO user_career_history
             (user_id, import_id, entry_type, raw_data, display_order)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5)
       RETURNING id`,
      [userId, importId, entryType, JSON.stringify(rawData), displayOrder],
    );
    const row = result.rows[0];
    if (!row) throw new Error('persistCareerEntries: INSERT returned no row');
    return row.id;
  } finally {
    stop();
  }
}

export async function persistCareerEntries(
  pool: Pool,
  userId: string,
  importId: string,
  data: ExtractedCareerData,
): Promise<PersistedCareerEntries> {
  const client = await pool.connect();
  const allEntryIds: string[] = [];
  const experienceIds: string[] = [];

  const insertEntry = async (
    entryType: string,
    rawData: Record<string, unknown>,
    displayOrder: number,
  ): Promise<string> => {
    const id = await insertCareerEntry(client, userId, importId, entryType, rawData, displayOrder);
    allEntryIds.push(id);
    if (entryType === 'experience') experienceIds.push(id);
    return id;
  };

  try {
    await client.query('BEGIN');
    await client.query(
      `DELETE FROM user_career_history
        WHERE user_id = $1::uuid
          AND import_id = $2::uuid`,
      [userId, importId],
    );

    for (let i = 0; i < data.experience.length; i++) {
      await insertEntry('experience', data.experience[i] as unknown as Record<string, unknown>, i);
    }
    for (let i = 0; i < data.education.length; i++) {
      await insertEntry('education', data.education[i] as unknown as Record<string, unknown>, i);
    }
    for (let i = 0; i < data.skills.length; i++) {
      await insertEntry('skill', data.skills[i] as unknown as Record<string, unknown>, i);
    }
    for (let i = 0; i < data.certifications.length; i++) {
      await insertEntry('certification', data.certifications[i] as unknown as Record<string, unknown>, i);
    }
    for (let i = 0; i < data.projects.length; i++) {
      await insertEntry('project', data.projects[i] as unknown as Record<string, unknown>, i);
    }
    for (let i = 0; i < data.keyAchievements.length; i++) {
      await insertEntry('achievement', data.keyAchievements[i] as unknown as Record<string, unknown>, i);
    }

    await client.query(
      `UPDATE resume_imports SET career_entries_created = $1 WHERE id = $2::uuid`,
      [allEntryIds, importId],
    );

    await client.query('COMMIT');
    return { allEntryIds, experienceIds };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
