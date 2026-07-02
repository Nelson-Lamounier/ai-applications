import { describe, it, expect, jest } from '@jest/globals';
import type { BedrockRuntimeClient, ConverseCommandOutput } from '@aws-sdk/client-bedrock-runtime';
import { BedrockEvidenceAdjudicator } from './evidence-adjudicator.js';
import type { Finding } from '../lint/article-lint-rules.js';

function finding(rule: string, message: string): Finding {
  return { rule, severity: 'warn', message };
}

function toolResponse(
  verdicts: Array<{ index: number; decision: string; reason: string }>,
): ConverseCommandOutput {
  return {
    output: { message: { content: [{ toolUse: { input: { verdicts } } }] } },
    usage: { inputTokens: 10, outputTokens: 5 },
  } as unknown as ConverseCommandOutput;
}

function makeAdjudicator(send: jest.Mock) {
  const client = { send } as unknown as BedrockRuntimeClient;
  return new BedrockEvidenceAdjudicator({ client });
}

const KB = ['Pod Identity associations use AWS::EKS::PodIdentityAssociation.'];

describe('BedrockEvidenceAdjudicator', () => {
  it('skips Bedrock entirely when no finding routes to it', async () => {
    const send = jest.fn();
    const adj = makeAdjudicator(send as unknown as jest.Mock);
    const r = await adj.adjudicate({
      findings: [finding('em-dash-density', 'too many'), finding('shallow-link', 'homepage')],
      contextChunks: KB,
      draft: 'body',
    });
    expect(r).toEqual({ verdicts: [], defects: 0 });
    expect(send).not.toHaveBeenCalled();
  });

  it('maps DEFECT / CLEARED decisions from the tool output', async () => {
    const send = jest.fn<() => Promise<ConverseCommandOutput>>().mockResolvedValue(
      toolResponse([
        { index: 0, decision: 'DEFECT', reason: 'no per-member evidence' },
        { index: 1, decision: 'CLEARED', reason: 'developed in body' },
      ]),
    );
    const adj = makeAdjudicator(send as unknown as jest.Mock);
    const r = await adj.adjudicate({
      findings: [
        finding('enumerated-generalisation', 'PDBs and Certificates all ...'),
        finding('title-coverage', 'golden path'),
      ],
      contextChunks: KB,
      draft: 'body',
    });
    expect(r.defects).toBe(1);
    expect(r.verdicts[0].decision).toBe('DEFECT');
    expect(r.verdicts[1].decision).toBe('CLEARED');
  });

  it('fails safe to DEFECT for any routed finding the model omits', async () => {
    const send = jest.fn<() => Promise<ConverseCommandOutput>>().mockResolvedValue(
      toolResponse([{ index: 0, decision: 'CLEARED', reason: 'ok' }]),
    );
    const adj = makeAdjudicator(send as unknown as jest.Mock);
    const r = await adj.adjudicate({
      findings: [
        finding('title-coverage', 'a'),
        finding('dangling-reference', 'b'), // no verdict returned → DEFECT
      ],
      contextChunks: KB,
      draft: 'body',
    });
    expect(r.verdicts[1].decision).toBe('DEFECT');
    expect(r.defects).toBe(1);
  });

  it('fails safe to DEFECT on a Bedrock error', async () => {
    const send = jest.fn<() => Promise<ConverseCommandOutput>>().mockRejectedValue(new Error('throttled'));
    const adj = makeAdjudicator(send as unknown as jest.Mock);
    const r = await adj.adjudicate({
      findings: [finding('enumerated-generalisation', 'x'), finding('title-coverage', 'y')],
      contextChunks: KB,
      draft: 'body',
    });
    expect(r.defects).toBe(2);
    expect(r.verdicts.every((v) => v.decision === 'DEFECT')).toBe(true);
  });
});
