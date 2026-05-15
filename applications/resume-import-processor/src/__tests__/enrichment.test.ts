import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const mockEnrichRole         = jest.fn();
const mockEmbedAndPersist    = jest.fn();
const mockRecordBedrockCost  = jest.fn();

jest.mock('../bedrock/enrich-role.js', () => ({ enrichRole: mockEnrichRole }));
jest.mock('../embed.js', () => ({ embedAndPersistEntry: mockEmbedAndPersist }));
jest.mock('@bedrock/shared', () => ({ recordBedrockCost: mockRecordBedrockCost }));

import { enrichAndEmbedRole, countEnrichedEntries } from '../enrichment.js';
import type { ResumeExperience } from '../bedrock/extract-career.js';

const EXP: ResumeExperience = {
  company: 'TechCorp',
  title: 'Senior Engineer',
  period: '2020-2023',
  highlights: ['Led team'],
  confidenceFlags: [],
};

const ENRICHED = {
  roleDescription: 'desc',
  responsibilities: ['r1'],
  transferableSkills: ['s1'],
  industryContext: 'ctx',
  typicalTechStack: ['ts'],
  careerLevel: 'senior' as const,
};

interface FakePool {
  query: jest.Mock;
}

function makePool(countValue = '0'): FakePool {
  const query = jest.fn(async (sql: unknown) => {
    if (String(sql).includes('COUNT(*)')) return { rows: [{ count: countValue }] };
    return { rows: [] };
  }) as jest.Mock;
  return { query };
}

const log = { info: jest.fn(), warn: jest.fn() };

function statusWrites(pool: FakePool): string[] {
  return pool.query.mock.calls
    .map((c) => String(c[0]))
    // UPDATE-only: the free-tier COUNT query also contains
    // "enrichment_status = 'complete'" in its WHERE and must not be counted.
    .filter((s) => s.includes('UPDATE user_career_history') && s.includes('SET enrichment_status ='))
    .map((s) => {
      if (s.includes("'failed'"))   return 'failed';
      if (s.includes("'complete'")) return 'complete';
      if (s.includes("'enriching'")) return 'enriching';
      if (s.includes('free_tier_limit')) return 'skipped:free_tier';
      if (s.includes('no_search_results')) return 'skipped:no_results';
      return 'other';
    });
}

const baseArgs = (pool: FakePool) => ({
  pool: pool as never,
  region: 'eu-west-1',
  userId: 'u1',
  importId: 'imp1',
  searchTool: { search: jest.fn(async () => []) } as never,
  log: log as never,
  exp: EXP,
  careerEntryId: 'ce1',
  roleIndex: 0,
});

describe('countEnrichedEntries', () => {
  it('parses the COUNT result', async () => {
    const pool = makePool('7');
    expect(await countEnrichedEntries(pool as never, 'u1')).toBe(7);
  });
  it('defaults to 0 when no row', async () => {
    const pool = { query: jest.fn(async () => ({ rows: [] })) } as FakePool;
    expect(await countEnrichedEntries(pool as never, 'u1')).toBe(0);
  });
});

describe('enrichAndEmbedRole', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEmbedAndPersist.mockResolvedValue(3 as never);
    // enrichment.ts calls recordBedrockCost(...).catch(...) — the mock must
    // return a promise or the .catch() throws synchronously.
    mockRecordBedrockCost.mockResolvedValue(undefined as never);
  });

  it('skips enrichment when the free-tier cap is reached, still embeds', async () => {
    const pool = makePool('5'); // >= FREE_TIER_ENRICHMENT_CAP
    const res = await enrichAndEmbedRole(baseArgs(pool));

    expect(res.outcome).toBe('skipped');
    expect(res.embeddings).toBe(3);
    expect(mockEnrichRole).not.toHaveBeenCalled();
    expect(statusWrites(pool)).toContain('skipped:free_tier');
    // embed called with null enrichment
    expect(mockEmbedAndPersist).toHaveBeenCalledWith(
      pool, 'eu-west-1', 'u1', 'ce1', EXP, null, 'imp1',
    );
  });

  it('marks complete and embeds enriched data on success', async () => {
    const pool = makePool('0');
    mockEnrichRole.mockResolvedValue({ data: ENRICHED, inputTokens: 100, outputTokens: 50 } as never);

    const res = await enrichAndEmbedRole(baseArgs(pool));

    expect(res.outcome).toBe('success');
    expect(res.embeddings).toBe(3);
    const writes = statusWrites(pool);
    expect(writes).toContain('enriching');
    expect(writes).toContain('complete');
    expect(mockRecordBedrockCost).toHaveBeenCalled();
    expect(mockEmbedAndPersist).toHaveBeenCalledWith(
      pool, 'eu-west-1', 'u1', 'ce1', EXP, ENRICHED, 'imp1',
    );
  });

  it('marks skipped:no_results when enrichRole returns null data', async () => {
    const pool = makePool('0');
    mockEnrichRole.mockResolvedValue({ data: null, inputTokens: 0, outputTokens: 0 } as never);

    const res = await enrichAndEmbedRole(baseArgs(pool));

    expect(res.outcome).toBe('skipped');
    expect(statusWrites(pool)).toContain('skipped:no_results');
    expect(mockRecordBedrockCost).not.toHaveBeenCalled();
  });

  it('marks failed without a double status write when enrichRole throws', async () => {
    const pool = makePool('0');
    mockEnrichRole.mockRejectedValue(new Error('bedrock 500') as never);

    const res = await enrichAndEmbedRole(baseArgs(pool));

    expect(res.outcome).toBe('failed');
    const writes = statusWrites(pool);
    expect(writes).toContain('failed');
    // The bug this guards: 'failed' must NOT be followed by a skipped/complete write
    expect(writes.filter((w) => w.startsWith('skipped') || w === 'complete')).toHaveLength(0);
    // Embeddings still run so basic retrieval works without enrichment
    expect(mockEmbedAndPersist).toHaveBeenCalled();
    expect(res.embeddings).toBe(3);
  });
});
