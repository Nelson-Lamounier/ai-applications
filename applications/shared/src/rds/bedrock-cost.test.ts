import { computeCostCents } from './bedrock-cost';

describe('computeCostCents', () => {
  it('computes Haiku costs correctly', () => {
    const result = computeCostCents(
      'eu.anthropic.claude-haiku-4-5-20251001-v1:0',
      1000,
      500,
    );
    expect(result.inputCostCents).toBeCloseTo(0.080, 3);
    expect(result.outputCostCents).toBeCloseTo(0.200, 3);
    expect(result.totalCostCents).toBeCloseTo(0.280, 3);
  });

  it('computes Titan costs correctly (output is zero)', () => {
    const result = computeCostCents('amazon.titan-embed-text-v2:0', 500, 0);
    expect(result.inputCostCents).toBeCloseTo(0.0013002, 6);
    expect(result.outputCostCents).toBe(0);
  });

  it('falls back to default pricing for unknown model', () => {
    const result = computeCostCents('unknown-model', 1000, 1000);
    expect(result.totalCostCents).toBeGreaterThan(0);
  });
});
