/** @format */
import { describe, it, expect, jest } from '@jest/globals';

import { careerIdentityKey, persistCareerEntries } from '../career-persist.js';
import type { ExtractedCareerData } from '../bedrock/extract-career.js';

function makeData(overrides: Partial<ExtractedCareerData> = {}): ExtractedCareerData {
  return {
    profile: { name: 'N', title: 'T', email: 'e@x.com', location: 'L' },
    summary: 's',
    experience: [],
    skills: [],
    education: [],
    certifications: [],
    projects: [],
    keyAchievements: [],
    ...overrides,
  };
}

interface Call { sql: string; params: unknown[] }

function makeClient(opts: { failOnInsert?: boolean } = {}) {
  const calls: Call[] = [];
  let inserted = 0;
  const query = jest.fn(async (sql: unknown, params?: unknown[]) => {
    const text = String(sql);
    calls.push({ sql: text, params: params ?? [] });
    if (text.includes('INSERT INTO user_career_history')) {
      if (opts.failOnInsert) throw new Error('boom');
      inserted += 1;
      return { rows: [{ id: `id-${inserted}` }] };
    }
    return { rows: [] };
  });
  return { calls, client: { query, release: jest.fn() } };
}

function makePool(client: unknown) {
  return { connect: jest.fn(async () => client) } as never;
}

describe('careerIdentityKey', () => {
  it('normalises case and whitespace for experience company+title', () => {
    expect(careerIdentityKey('experience', { company: '  Amazon  Web Services ', title: 'ENGINEER ' }))
      .toBe('amazon web services|engineer');
  });

  it('keys each entry type on its identity fields', () => {
    expect(careerIdentityKey('education', { degree: 'BSc', institution: 'CCT' })).toBe('bsc|cct');
    expect(careerIdentityKey('certification', { name: 'AWS DevOps Pro' })).toBe('aws devops pro');
    expect(careerIdentityKey('skill', { category: 'Kubernetes & GitOps' })).toBe('kubernetes & gitops');
    expect(careerIdentityKey('project', { name: 'Platform' })).toBe('platform');
    expect(careerIdentityKey('achievement', { achievement: 'Did X' })).toBe('did x');
  });

  it('returns null when identity fields are blank or the type is unknown', () => {
    expect(careerIdentityKey('experience', { company: ' ', title: '' })).toBeNull();
    expect(careerIdentityKey('certification', {})).toBeNull();
    expect(careerIdentityKey('mystery', { name: 'x' })).toBeNull();
  });
});

describe('persistCareerEntries', () => {
  const data = makeData({
    experience: [
      { company: 'AWS', title: 'Associate', period: '2022 -', highlights: ['h'], confidenceFlags: [] },
    ],
    skills: [{ category: 'Kubernetes & GitOps', skills: ['kubeadm'] }],
    certifications: [{ name: 'AWS DevOps Pro', year: '2025', issuer: 'AWS' }],
  });

  it('runs one transaction: import-scoped delete, identity deletes, inserts, ledger update', async () => {
    const { calls, client } = makeClient();
    const ids = await persistCareerEntries(makePool(client), 'user-1', 'import-1', data);

    expect(ids).toEqual(['id-1']);
    const sqls = calls.map(c => c.sql);
    expect(sqls[0]).toBe('BEGIN');
    expect(sqls[sqls.length - 1]).toBe('COMMIT');

    const importDelete = calls.find(c => c.sql.includes('import_id = $2::uuid') && c.sql.startsWith('DELETE'));
    expect(importDelete?.params).toEqual(['user-1', 'import-1']);

    const identityDeletes = calls.filter(c => c.sql.includes('= ANY($3::text[])'));
    expect(identityDeletes.map(c => c.params[1]).sort()).toEqual(['certification', 'experience', 'skill']);
    const expDelete = identityDeletes.find(c => c.params[1] === 'experience');
    expect(expDelete?.params[2]).toEqual(['aws|associate']);

    const lastDeleteIdx = sqls.reduce((acc, s, i) => (s.startsWith('DELETE') ? i : acc), -1);
    const firstInsertIdx = sqls.findIndex(s => s.includes('INSERT INTO user_career_history'));
    expect(lastDeleteIdx).toBeLessThan(firstInsertIdx);

    const ledger = calls.find(c => c.sql.includes('UPDATE resume_imports'));
    expect(ledger?.params).toEqual([['id-1'], 'import-1']);
  });

  it('skips identity deletion for blank-identity entries but still inserts them', async () => {
    const blank = makeData({
      keyAchievements: [{ achievement: '   ' }],
    });
    const { calls, client } = makeClient();
    await persistCareerEntries(makePool(client), 'user-1', 'import-1', blank);

    expect(calls.some(c => c.sql.includes('= ANY($3::text[])'))).toBe(false);
    expect(calls.some(c => c.sql.includes('INSERT INTO user_career_history'))).toBe(true);
  });

  it('rolls back and rethrows when a statement fails, then releases the client', async () => {
    const { calls, client } = makeClient({ failOnInsert: true });
    await expect(persistCareerEntries(makePool(client), 'user-1', 'import-1', data)).rejects.toThrow('boom');
    expect(calls.map(c => c.sql)).toContain('ROLLBACK');
    expect(calls.map(c => c.sql)).not.toContain('COMMIT');
    expect(client.release).toHaveBeenCalled();
  });
});
