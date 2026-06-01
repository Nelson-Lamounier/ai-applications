/**
 * @format
 * Unit tests for embedBaselineEntries — the helper that writes baseline
 * (pre-enrichment) career embeddings at import time.
 *
 * Mocking style mirrors enrichment.test.ts: top-level jest.mock with a manual
 * factory, then import the module under test after the mocks are registered.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const mockEmbedAndPersistEntry = jest.fn();

jest.mock('../embed.js', () => ({ embedAndPersistEntry: mockEmbedAndPersistEntry }));

// @bedrock/shared is imported by baseline-embed.ts (for jobLogger) — stub so
// the test runs without real AWS credentials or OTel bootstrapping.
jest.mock('@bedrock/shared', () => ({
  jobLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

import { embedBaselineEntries } from '../baseline-embed.js';
import type { ResumeExperience } from '../bedrock/extract-career.js';

// ── fixtures ──────────────────────────────────────────────────────────────────

function makeExperience(title: string): ResumeExperience {
  return {
    company: 'ACME Corp',
    title,
    period: '2021-2024',
    highlights: ['shipped X', 'led Y'],
    confidenceFlags: [],
  };
}

function makePool() {
  return { query: jest.fn(async () => ({ rows: [] })) } as unknown as import('pg').Pool;
}

const USER_ID   = 'user-abc';
const IMPORT_ID = 'import-xyz';
const REGION    = 'eu-west-1';

// ── tests ─────────────────────────────────────────────────────────────────────

describe('embedBaselineEntries', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: each call embeds 2 chunks and succeeds.
    mockEmbedAndPersistEntry.mockResolvedValue(2 as never);
  });

  it('calls embedAndPersistEntry once per experience entry', async () => {
    const pool        = makePool();
    const experiences = [makeExperience('Engineer'), makeExperience('Lead')];
    const ids         = ['id-1', 'id-2'];

    await embedBaselineEntries(pool, REGION, USER_ID, IMPORT_ID, ids, experiences);

    expect(mockEmbedAndPersistEntry).toHaveBeenCalledTimes(2);
  });

  it('passes enriched=null for every entry (baseline, not enriched)', async () => {
    const pool        = makePool();
    const experiences = [makeExperience('SWE'), makeExperience('PM'), makeExperience('Staff')];
    const ids         = ['id-1', 'id-2', 'id-3'];

    await embedBaselineEntries(pool, REGION, USER_ID, IMPORT_ID, ids, experiences);

    for (const call of mockEmbedAndPersistEntry.mock.calls) {
      // signature: (pool, region, userId, careerEntryId, experience, enriched, importId)
      const enriched = call[5];
      expect(enriched).toBeNull();
    }
  });

  it('passes correct (pool, region, userId, id, experience, importId) to each call', async () => {
    const pool        = makePool();
    const exp0        = makeExperience('Junior');
    const exp1        = makeExperience('Senior');
    const ids         = ['id-A', 'id-B'];

    await embedBaselineEntries(pool, REGION, USER_ID, IMPORT_ID, ids, [exp0, exp1]);

    expect(mockEmbedAndPersistEntry).toHaveBeenNthCalledWith(
      1, pool, REGION, USER_ID, 'id-A', exp0, null, IMPORT_ID,
    );
    expect(mockEmbedAndPersistEntry).toHaveBeenNthCalledWith(
      2, pool, REGION, USER_ID, 'id-B', exp1, null, IMPORT_ID,
    );
  });

  it('returns the total count of embeddings written', async () => {
    const pool        = makePool();
    const experiences = [makeExperience('A'), makeExperience('B'), makeExperience('C')];
    const ids         = ['i1', 'i2', 'i3'];
    mockEmbedAndPersistEntry.mockResolvedValue(3 as never);

    const total = await embedBaselineEntries(pool, REGION, USER_ID, IMPORT_ID, ids, experiences);

    expect(total).toBe(9); // 3 entries × 3 chunks each
  });

  it('is non-fatal: skips a failing entry and continues with the rest', async () => {
    const pool = makePool();
    const ids  = ['id-ok1', 'id-fail', 'id-ok2'];
    const experiences = [
      makeExperience('ok1'),
      makeExperience('fail'),
      makeExperience('ok2'),
    ];

    mockEmbedAndPersistEntry
      .mockResolvedValueOnce(2 as never)
      .mockRejectedValueOnce(new Error('Bedrock throttled') as never)
      .mockResolvedValueOnce(2 as never);

    const total = await embedBaselineEntries(pool, REGION, USER_ID, IMPORT_ID, ids, experiences);

    // Should not throw; failing entry contributes 0 chunks
    expect(total).toBe(4);
    expect(mockEmbedAndPersistEntry).toHaveBeenCalledTimes(3);
  });

  it('handles an empty experience list without calling the embed function', async () => {
    const pool = makePool();

    const total = await embedBaselineEntries(pool, REGION, USER_ID, IMPORT_ID, [], []);

    expect(total).toBe(0);
    expect(mockEmbedAndPersistEntry).not.toHaveBeenCalled();
  });
});
