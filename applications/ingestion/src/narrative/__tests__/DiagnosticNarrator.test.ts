import { DiagnosticNarrator } from '../DiagnosticNarrator.js';
import type { DiagnosticComputed } from '@bedrock/shared';

const computed = {
  overall: 78,
  components: {
    profileDepth:            { score: 86, blockers: [] },
    ragDepth:                { score: 70, blockers: ['No project repos with high KB quality'] },
    directionConfidence:     { score: 80, blockers: [] },
    reconciliationAlignment: { score: 80, blockers: ['Led a 12-person ML platform team'] },
    resumeCoverage:          { score: 75, blockers: [] },
  },
  methodology: { version: 1, weights: { profileDepth:20, ragDepth:20, directionConfidence:20, reconciliationAlignment:20, resumeCoverage:20 }, notes: 'Equal-weight v1' },
} as unknown as DiagnosticComputed;

function gen(out: unknown) { return { invoke: jest.fn(async () => out) }; }

describe('DiagnosticNarrator.narrate', () => {
  it('returns the explanation string on a valid schema result', async () => {
    const n = new DiagnosticNarrator(gen({ explanation: 'Your readiness score reflects strong infrastructure evidence offset by a couple of unsupported résumé claims and one underdeveloped retrieval area.' }) as never);
    await expect(n.narrate(computed)).resolves.toBe('Your readiness score reflects strong infrastructure evidence offset by a couple of unsupported résumé claims and one underdeveloped retrieval area.');
  });

  it('returns undefined when the explanation is below the schema min (40 chars)', async () => {
    const n = new DiagnosticNarrator(gen({ explanation: 'too short' }) as never);
    await expect(n.narrate(computed)).resolves.toBeUndefined();
  });

  it('returns undefined when the explanation exceeds the schema max (400 chars)', async () => {
    const long = 'x'.repeat(500);
    const n = new DiagnosticNarrator(gen({ explanation: long }) as never);
    await expect(n.narrate(computed)).resolves.toBeUndefined();
  });

  it('returns undefined on schema-invalid output (missing field)', async () => {
    const n = new DiagnosticNarrator(gen({ wrong_field: 'x' }) as never);
    await expect(n.narrate(computed)).resolves.toBeUndefined();
  });

  it('returns undefined (never throws) when the generator throws', async () => {
    const n = new DiagnosticNarrator({ invoke: jest.fn(async () => { throw new Error('bedrock down'); }) } as never);
    await expect(n.narrate(computed)).resolves.toBeUndefined();
  });
});
