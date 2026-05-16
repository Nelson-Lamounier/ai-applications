import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const sendMock = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const groundingVerifyMock = jest.fn<(...args: unknown[]) => Promise<unknown>>();

jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn().mockImplementation(() => ({ send: sendMock })),
  InvokeModelCommand: jest.fn().mockImplementation((args: unknown) => ({ args })),
}));

jest.mock('@bedrock/shared', () => ({
  ...jest.requireActual<object>('@bedrock/shared'),
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

function bedrockReplyWith(perRole: Array<{ roleId: string }>) {
  return {
    body: Buffer.from(JSON.stringify({
      usage: { input_tokens: 500, output_tokens: 200 },
      content: [{
        type: 'tool_use',
        input: {
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
        },
      }],
    })),
  };
}

describe('generateGapAnalysis', () => {
  beforeEach(() => {
    sendMock.mockReset();
    groundingVerifyMock.mockReset();
    groundingVerifyMock.mockResolvedValue({
      status: 'GROUNDED',
      reason: 'supported by highlights',
      ungroundedClaims: [],
      answer: 'add metric (ATS boost)',
    });
  });

  it('single call for <= MAX_ROLES_PER_CALL roles, returns parsed report + tokens', async () => {
    sendMock.mockResolvedValue(bedrockReplyWith([{ roleId: 'r1' }, { roleId: 'r2' }]));

    const res = await generateGapAnalysis([role(1), role(2)], 0, 'eu-west-1');

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(res.data.overallScore).toBe(72);
    expect(res.data.perRole.map((p) => p.roleId)).toEqual(['r1', 'r2']);
    expect(res.inputTokens).toBe(500);
    expect(res.outputTokens).toBe(200);
  });

  it('batches when role count exceeds MAX_ROLES_PER_CALL and merges perRole', async () => {
    const roles = Array.from({ length: MAX_ROLES_PER_CALL + 2 }, (_, i) => role(i + 1));
    // First batch = first MAX_ROLES_PER_CALL roles, second batch = remaining 2
    const firstIds  = roles.slice(0, MAX_ROLES_PER_CALL).map((r) => ({ roleId: r.roleId }));
    const secondIds = roles.slice(MAX_ROLES_PER_CALL).map((r) => ({ roleId: r.roleId }));
    sendMock
      .mockResolvedValueOnce(bedrockReplyWith(firstIds))
      .mockResolvedValueOnce(bedrockReplyWith(secondIds));

    const res = await generateGapAnalysis(roles, 3, 'eu-west-1');

    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(res.data.perRole).toHaveLength(MAX_ROLES_PER_CALL + 2);
    expect(res.inputTokens).toBe(1000);  // 500 + 500
    expect(res.outputTokens).toBe(400);  // 200 + 200
  });

  it('throws when Bedrock returns no tool_use block', async () => {
    sendMock.mockResolvedValue({
      body: Buffer.from(JSON.stringify({ content: [{ type: 'text', text: 'oops' }] })),
    });
    await expect(generateGapAnalysis([role(1)], 0, 'eu-west-1'))
      .rejects.toThrow('no tool_use block');
  });

  it('attaches grounding metadata per role and never blocks (flag mode)', async () => {
    groundingVerifyMock.mockResolvedValue({
      status: 'NOT_GROUNDED',
      reason: 'unsupported',
      ungroundedClaims: ['inflated bullet'],
      answer: 'ORIGINAL',
    });
    sendMock.mockResolvedValue(bedrockReplyWith([{ roleId: 'r1' }]));

    const result = await generateGapAnalysis([role(1, true)], 0, 'eu-west-1');

    expect(result.data).toBeDefined();               // report NOT mutated/blocked
    expect((result.groundingMetadata ?? []).length).toBeGreaterThan(0);
    expect(result.groundingMetadata?.[0].status).toBe('NOT_GROUNDED');
  });

  it('grounding metadata is attached for each role in a batched call', async () => {
    const roles = Array.from({ length: MAX_ROLES_PER_CALL + 1 }, (_, i) => role(i + 1));
    const firstIds  = roles.slice(0, MAX_ROLES_PER_CALL).map((r) => ({ roleId: r.roleId }));
    const secondIds = roles.slice(MAX_ROLES_PER_CALL).map((r) => ({ roleId: r.roleId }));
    sendMock
      .mockResolvedValueOnce(bedrockReplyWith(firstIds))
      .mockResolvedValueOnce(bedrockReplyWith(secondIds));

    const res = await generateGapAnalysis(roles, 0, 'eu-west-1');

    expect(res.groundingMetadata).toHaveLength(roles.length);
  });

  it('is fail-open: a verify error does not throw and metadata entry is skipped', async () => {
    groundingVerifyMock.mockRejectedValue(new Error('Bedrock timeout'));
    sendMock.mockResolvedValue(bedrockReplyWith([{ roleId: 'r1' }]));

    const result = await generateGapAnalysis([role(1)], 0, 'eu-west-1');

    expect(result.data).toBeDefined();
    // Error swallowed — metadata array exists but may be empty or partial
    expect(result.groundingMetadata).toBeDefined();
  });

  it('skips grounding for roles with empty suggestedAdditions (no misleading NOT_GROUNDED entry)', async () => {
    // Bedrock returns a role whose suggestedAdditions array is empty.
    sendMock.mockResolvedValue({
      body: Buffer.from(JSON.stringify({
        usage: { input_tokens: 100, output_tokens: 50 },
        content: [{
          type: 'tool_use',
          input: {
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
          },
        }],
      })),
    });

    const result = await generateGapAnalysis([role(1)], 0, 'eu-west-1');

    // verify must NOT have been called for the empty-additions role
    expect(groundingVerifyMock).not.toHaveBeenCalled();
    // groundingMetadata should have no entry for r1
    expect(result.groundingMetadata).toHaveLength(0);
  });
});
