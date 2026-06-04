/**
 * @format
 */

import { describe, it, expect, jest } from '@jest/globals';
import type { PoolClient } from 'pg';

import { persistCareerEntries } from './career-persistence.js';
import type { ExtractedCareerData } from './bedrock/extract-career.js';

function makeExtracted(): ExtractedCareerData {
  return {
    profile: {
      name:     'Nelson',
      title:    'Engineer',
      email:    'nelson@example.com',
      location: 'Dublin',
    },
    summary: 'Engineer',
    experience: [
      { company: 'A', title: 'Engineer', period: '2020', highlights: ['built'], confidenceFlags: [] },
    ],
    education: [
      { institution: 'Uni', degree: 'BS', period: '2016' },
    ],
    skills: [
      { category: 'Languages', skills: ['TypeScript'] },
    ],
    certifications: [
      { name: 'AWS', issuer: 'Amazon', year: '2024' },
    ],
    projects: [
      { name: 'Project', description: 'Thing' },
    ],
    keyAchievements: [
      { achievement: 'Saved cost' },
    ],
  };
}

describe('persistCareerEntries', () => {
  it('deletes prior rows, inserts every entry type, tracks all IDs, and commits atomically', async () => {
    let id = 0;
    const query = jest.fn(async (sql: unknown, _params?: unknown[]) => {
      const text = String(sql);
      if (text.includes('INSERT INTO user_career_history')) {
        id += 1;
        return { rows: [{ id: `entry-${id}` }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });
    const client = { query, release: jest.fn() } as unknown as PoolClient;
    const pool = { connect: jest.fn(async () => client) };

    const result = await persistCareerEntries(pool as never, 'user-id', 'import-id', makeExtracted());

    expect(result.experienceIds).toEqual(['entry-1']);
    expect(result.allEntryIds).toEqual(['entry-1', 'entry-2', 'entry-3', 'entry-4', 'entry-5', 'entry-6']);
    expect(query.mock.calls.map((c) => c[0])).toContain('BEGIN');
    expect(String(query.mock.calls[1][0])).toContain('DELETE FROM user_career_history');
    const insertCalls = query.mock.calls.filter((c) => String(c[0]).includes('INSERT INTO user_career_history'));
    expect(insertCalls).toHaveLength(6);
    const updateCall = query.mock.calls.find((c) => String(c[0]).includes('UPDATE resume_imports SET career_entries_created'));
    expect(updateCall?.[1]).toEqual([result.allEntryIds, 'import-id']);
    expect(query.mock.calls.map((c) => c[0])).toContain('COMMIT');
    expect(client.release).toHaveBeenCalled();
  });

  it('rolls back when any insert fails', async () => {
    const query = jest.fn(async (sql: unknown, _params?: unknown[]) => {
      if (String(sql).includes('INSERT INTO user_career_history')) {
        throw new Error('insert failed');
      }
      return { rows: [], rowCount: 1 };
    });
    const client = { query, release: jest.fn() } as unknown as PoolClient;
    const pool = { connect: jest.fn(async () => client) };

    await expect(
      persistCareerEntries(pool as never, 'user-id', 'import-id', makeExtracted()),
    ).rejects.toThrow('insert failed');

    expect(query.mock.calls.map((c) => c[0])).toContain('ROLLBACK');
    expect(client.release).toHaveBeenCalled();
  });
});
