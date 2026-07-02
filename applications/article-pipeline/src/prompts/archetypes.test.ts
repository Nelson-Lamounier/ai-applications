/**
 * archetypes.test.ts
 *
 * Selection + assembly tests. The inventories model real Tucaken article
 * scenarios: the EKS war-story piece, a tiered-enrichment deep dive, the
 * Step Functions vs K8s Jobs decision, and a thin-evidence topic that must
 * refuse to generate.
 */
import { describe, it, expect } from '@jest/globals';
import type { EvidenceInventory } from '@bedrock/shared';
import { selectArchetype } from './archetypes.js';
import { buildPromptFromBrief, type ResearchBrief } from './prompt-assembler.js';

const CORE = '# Writer Core Prompt\n(core rules here)';

function inv(partial: Partial<EvidenceInventory>): EvidenceInventory {
  return {
    failureNarratives: 0,
    metrics: 0,
    comparisons: 0,
    stepSequences: 0,
    decisionRecords: 0,
    deepLinks: 0,
    diagnosticArtifacts: 0,
    ...partial,
  };
}

function brief(inventory: EvidenceInventory): ResearchBrief {
  return {
    slug: 'test',
    topic: 'Test topic',
    evidenceInventory: inventory,
    citableLinks: [
      {
        url: 'https://karpenter.sh/docs/concepts/nodeclasses/#specmetadataoptions',
        supportsClaim: 'hop limit default',
      },
    ],
    publicRepos: ['cdk-monitoring'],
    publishIdentifiers: [],
    availableMetrics: [{ value: '11 minutes', measures: 'deploy time saved' }],
  };
}

describe('archetype selection', () => {
  it("picks war-story for the EKS article's evidence shape", () => {
    const sel = selectArchetype(
      inv({
        failureNarratives: 5,
        diagnosticArtifacts: 4,
        metrics: 3,
        decisionRecords: 3,
        deepLinks: 3,
      }),
    );
    expect(sel.archetype.id).toBe('war-story');
    expect(sel.eligible).toBe(true);
  });

  it('picks deep-dive when decisions and metrics dominate, failures are few', () => {
    // Tiered enrichment cascade: heavy on decisions/metrics, 1 failure.
    const sel = selectArchetype(
      inv({
        decisionRecords: 6,
        metrics: 7,
        deepLinks: 4,
        failureNarratives: 1,
        diagnosticArtifacts: 1,
      }),
    );
    expect(sel.archetype.id).toBe('deep-dive');
    expect(sel.eligible).toBe(true);
  });

  it('picks comparison for head-to-head evidence', () => {
    // Step Functions vs K8s Jobs decision.
    const sel = selectArchetype(
      inv({ comparisons: 3, metrics: 5, decisionRecords: 2, deepLinks: 2 }),
    );
    expect(sel.archetype.id).toBe('comparison');
    expect(sel.eligible).toBe(true);
  });

  it('picks build-log for step-sequence-dominant evidence', () => {
    const sel = selectArchetype(
      inv({
        stepSequences: 4,
        diagnosticArtifacts: 2,
        failureNarratives: 2,
        metrics: 1,
      }),
    );
    expect(sel.archetype.id).toBe('build-log');
    expect(sel.eligible).toBe(true);
  });

  it('marks ineligible when no archetype meets minimums (fabrication guard)', () => {
    const sel = selectArchetype(
      inv({ metrics: 1, deepLinks: 1, failureNarratives: 1 }),
    );
    expect(sel.eligible).toBe(false);
    expect(sel.fallbackReason).toContain('Do not generate');
  });

  it('emits gap warnings for thin consumed evidence', () => {
    const sel = selectArchetype(
      inv({ failureNarratives: 3, diagnosticArtifacts: 2, metrics: 2 }),
    );
    expect(sel.eligible).toBe(true);
    // build-log at exactly-met minimums with 1-unit fields warns per section.
    const sel2 = selectArchetype(
      inv({ stepSequences: 1, diagnosticArtifacts: 1, failureNarratives: 1 }),
    );
    expect(sel2.archetype.id).toBe('build-log');
    expect(sel2.gapWarnings.length).toBeGreaterThan(0);
  });
});

describe('prompt assembly', () => {
  it('composes core + archetype block + brief constraints', () => {
    const inventory = inv({
      failureNarratives: 5,
      diagnosticArtifacts: 4,
      metrics: 3,
    });
    const { prompt, selection } = buildPromptFromBrief(CORE, brief(inventory));
    expect(selection.archetype.id).toBe('war-story');
    expect(prompt).toContain('Writer Core Prompt');
    expect(prompt).toContain('ARCHETYPE: Production failure war story');
    expect(prompt).toContain('11 minutes — deploy time saved');
    expect(prompt).toContain('specmetadataoptions'); // the deep link survives
    expect(prompt).toContain('NONE. Generalise all operational identifiers');
  });

  it('computes per-section word budgets from shares', () => {
    const inventory = inv({
      failureNarratives: 5,
      diagnosticArtifacts: 4,
    });
    const { prompt } = buildPromptFromBrief(CORE, brief(inventory));
    // war-story midpoint 2700 * 0.58 = 1566
    expect(prompt).toMatch(/Section: failures \(~1566 words\)/);
  });

  it('throws instead of assembling when evidence is insufficient', () => {
    const inventory = inv({ metrics: 1 });
    expect(() => buildPromptFromBrief(CORE, brief(inventory))).toThrow(
      /Refusing to assemble/,
    );
  });
});
