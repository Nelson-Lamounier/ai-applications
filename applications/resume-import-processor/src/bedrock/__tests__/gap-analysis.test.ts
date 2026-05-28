import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// generateGapAnalysis now goes through the shared runAgent() wrapper. The mock
// runs the agent's parseResponse over a queued tool input (so schema validation
// is still exercised) and returns the configured token usage. A reply QUEUE
// supports the batched (multi-call) cases; `throwError` simulates a runAgent
// failure (refusal / no tool_use). The real BedrockGroundingVerifier is still
// overridden so grounding behaviour is unchanged.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let replyQueue: Array<{ input: any; tokens: { inputTokens: number; outputTokens: number; thinkingTokens: number } }> = [];
let throwError: Error | null = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockRunAgent = jest.fn(async (opts: any) => {
  if (throwError) throw throwError;
  const item = replyQueue.shift();
  if (!item) throw new Error('test: replyQueue empty');
  const data = await opts.parseResponse(JSON.stringify(item.input));
  return { data, tokenUsage: item.tokens, durationMs: 1, agentName: opts.config.agentName, modelId: opts.config.modelId, costUsd: 0 };
});

const groundingVerifyMock = jest.fn<(...args: unknown[]) => Promise<unknown>>();

jest.mock('@bedrock/shared', () => ({
  ...jest.requireActual<object>('@bedrock/shared'),
  runAgent: (opts: unknown) => mockRunAgent(opts),
  BedrockGroundingVerifier: jest.fn().mockImplementation(() => ({
    verify: groundingVerifyMock,
  })),
}));

import { generateGapAnalysis, MAX_ROLES_PER_CALL, type GapAnalysisRole } from '../gap-analysis.js';
import type { ResumeExperience } from '../extract-career.js';

function exp(n: number): ResumeExperience {
  return {
    company: `Co${n}`, title: `Title ${n}`, period: `20${10 + n}-20${11 + n}`,
    highlights: [`did thing ${n}`], confidenceFlags: [],
  };
}

function role(n: number, ctx = false): GapAnalysisRole {
  return {
    roleId: `r${n}`,
    experience: exp(n),
    publicContext: ctx ? [{ title: 't', url: 'u', content: 'web ctx', score: 1 }] : null,
  };
}

// Tool input object the model would emit (previously wrapped in a Bedrock response).
function gapInput(perRole: Array<{ roleId: string }>) {
  return {
    overallScore: 72,
    perRole: perRole.map((p) => ({
      roleId: p.roleId, company: 'C', title: 'T', period: 'P',
      completenessScore: 60, coveredResponsibilities: [], missingResponsibilities: [],
      suggestedAdditions: [{ bullet: 'add metric', rationale: 'ATS boost' }],
      quantificationOpportunities: [], keywordsForATS: [],
      externalValidation: 'limited',
    })),
    skillsGap: { present: ['a'], missing: ['b'], emerging: ['c'] },
    narrativeFeedback: 'solid',
    freeTierLimit: { rolesSkipped: 0, upgradeCta: null },
  };
}

const TOKENS = { inputTokens: 500, outputTokens: 200, thinkingTokens: 0 };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function queueReply(input: any, tokens = TOKENS) { replyQueue.push({ input, tokens }); }

describe('generateGapAnalysis', () => {
  beforeEach(() => {
    mockRunAgent.mockClear();
    replyQueue = [];
    throwError = null;
    groundingVerifyMock.mockReset();
    groundingVerifyMock.mockResolvedValue({
      status: 'GROUNDED',
      reason: 'supported by highlights',
      ungroundedClaims: [],
      answer: 'add metric (ATS boost)',
    });
  });

  it('single call for <= MAX_ROLES_PER_CALL roles, returns parsed report + tokens', async () => {
    queueReply(gapInput([{ roleId: 'r1' }, { roleId: 'r2' }]));

    const res = await generateGapAnalysis([role(1), role(2)], 0, 'eu-west-1');

    expect(mockRunAgent).toHaveBeenCalledTimes(1);
    expect(res.data.overallScore).toBe(72);
    expect(res.data.perRole.map((p) => p.roleId)).toEqual(['r1', 'r2']);
    expect(res.inputTokens).toBe(500);
    expect(res.outputTokens).toBe(200);
  });

  it('batches when role count exceeds MAX_ROLES_PER_CALL and merges perRole', async () => {
    const roles = Array.from({ length: MAX_ROLES_PER_CALL + 2 }, (_, i) => role(i + 1));
    const firstIds  = roles.slice(0, MAX_ROLES_PER_CALL).map((r) => ({ roleId: r.roleId }));
    const secondIds = roles.slice(MAX_ROLES_PER_CALL).map((r) => ({ roleId: r.roleId }));
    queueReply(gapInput(firstIds));
    queueReply(gapInput(secondIds));

    const res = await generateGapAnalysis(roles, 3, 'eu-west-1');

    expect(mockRunAgent).toHaveBeenCalledTimes(2);
    expect(res.data.perRole).toHaveLength(MAX_ROLES_PER_CALL + 2);
    expect(res.inputTokens).toBe(1000);  // 500 + 500
    expect(res.outputTokens).toBe(400);  // 200 + 200
  });

  it('maps a runAgent failure (no tool_use) to a thrown error', async () => {
    throwError = new Error('forced tool produced no tool_use block');
    await expect(generateGapAnalysis([role(1)], 0, 'eu-west-1'))
      .rejects.toThrow('no tool_use block');
  });

  it('throws a typed schema_validation_failed error on a malformed report', async () => {
    queueReply({
      // overallScore missing + perRole entries missing required keys
      perRole: [{ roleId: 'r1' }],
      skillsGap: { present: [], missing: [], emerging: [] },
      narrativeFeedback: 'x',
      freeTierLimit: { rolesSkipped: 0, upgradeCta: null },
    });
    await expect(generateGapAnalysis([role(1)], 0, 'eu-west-1')).rejects.toMatchObject({
      name: 'GapAnalysisError',
      code: 'schema_validation_failed',
    });
  });

  it('rejects a report that injects an unknown top-level field', async () => {
    queueReply({
      ...gapInput([{ roleId: 'r1' }]),
      suggestedAdditions: undefined,
      injected: 'nope',
    });
    await expect(generateGapAnalysis([role(1)], 0, 'eu-west-1')).rejects.toMatchObject({
      name: 'GapAnalysisError',
      code: 'schema_validation_failed',
    });
  });

  it('attaches grounding metadata per role and never blocks (flag mode)', async () => {
    groundingVerifyMock.mockResolvedValue({
      status: 'NOT_GROUNDED',
      reason: 'unsupported',
      ungroundedClaims: ['inflated bullet'],
      answer: 'ORIGINAL',
    });
    queueReply(gapInput([{ roleId: 'r1' }]));

    const result = await generateGapAnalysis([role(1, true)], 0, 'eu-west-1');

    expect(result.data).toBeDefined();
    expect((result.groundingMetadata ?? []).length).toBeGreaterThan(0);
    expect(result.groundingMetadata?.[0].status).toBe('NOT_GROUNDED');
  });

  it('grounding metadata is attached for each role in a batched call', async () => {
    const roles = Array.from({ length: MAX_ROLES_PER_CALL + 1 }, (_, i) => role(i + 1));
    queueReply(gapInput(roles.slice(0, MAX_ROLES_PER_CALL).map((r) => ({ roleId: r.roleId }))));
    queueReply(gapInput(roles.slice(MAX_ROLES_PER_CALL).map((r) => ({ roleId: r.roleId }))));

    const res = await generateGapAnalysis(roles, 0, 'eu-west-1');

    expect(res.groundingMetadata).toHaveLength(roles.length);
  });

  it('is fail-open: a verify error does not throw and metadata entry is skipped', async () => {
    groundingVerifyMock.mockRejectedValue(new Error('Bedrock timeout'));
    queueReply(gapInput([{ roleId: 'r1' }]));

    const result = await generateGapAnalysis([role(1)], 0, 'eu-west-1');

    expect(result.data).toBeDefined();
    expect(result.groundingMetadata).toBeDefined();
  });

  it('skips grounding for roles with empty suggestedAdditions (no misleading NOT_GROUNDED entry)', async () => {
    queueReply({
      overallScore: 55,
      perRole: [{
        roleId: 'r1', company: 'C', title: 'T', period: 'P',
        completenessScore: 40,
        coveredResponsibilities: [],
        missingResponsibilities: ['missing X'],
        suggestedAdditions: [],          // empty — must skip verify
        quantificationOpportunities: [],
        keywordsForATS: [],
        externalValidation: 'limited',
      }],
      skillsGap: { present: [], missing: [], emerging: [] },
      narrativeFeedback: 'needs work',
      freeTierLimit: { rolesSkipped: 0, upgradeCta: null },
    }, { inputTokens: 100, outputTokens: 50, thinkingTokens: 0 });

    const result = await generateGapAnalysis([role(1)], 0, 'eu-west-1');

    expect(groundingVerifyMock).not.toHaveBeenCalled();
    expect(result.groundingMetadata).toHaveLength(0);
  });
});
