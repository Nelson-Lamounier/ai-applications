/**
 * archetypes.ts
 *
 * Article archetypes as data, not prose. The Writer prompt is assembled at
 * runtime: universal core layer + the archetype block that scores highest
 * against the research brief's EVIDENCE INVENTORY.
 *
 * Core principle: the archetype is selected by what the KB actually
 * contains, never by topic intent. A "war story" article is only permitted
 * when the KB holds enough failure narratives to fill it — otherwise the
 * archetype itself becomes fabrication pressure.
 *
 * EvidenceInventory is the research→writer contract type; it lives in
 * @bedrock/shared so the Research agent can emit it on ResearchResult.
 */

import type { EvidenceInventory } from '@bedrock/shared';

// ---------------------------------------------------------------------------
// Archetype model
// ---------------------------------------------------------------------------

export interface SectionSpec {
  /** Working name; the Writer chooses the reader-facing heading. */
  name: string;
  /** Share of total body words, 0..1. Shares should sum to ~1. */
  budgetShare: number;
  /** Instruction injected verbatim into the archetype block. */
  instruction: string;
  /** Evidence field this section consumes; used for gap warnings. */
  consumes?: keyof EvidenceInventory;
}

export interface Archetype {
  id: string;
  displayName: string;
  /** Hard floor: archetype is ineligible unless every minimum is met. */
  minimums: Partial<Record<keyof EvidenceInventory, number>>;
  /** Per-unit scoring weights across the inventory. */
  weights: Partial<Record<keyof EvidenceInventory, number>>;
  totalWords: { min: number; max: number };
  titleGuidance: string;
  sections: SectionSpec[];
}

// ---------------------------------------------------------------------------
// The four archetypes
// ---------------------------------------------------------------------------

export const ARCHETYPES: Archetype[] = [
  {
    id: 'war-story',
    displayName: 'Production failure war story',
    minimums: { failureNarratives: 3, diagnosticArtifacts: 2 },
    weights: {
      failureNarratives: 5,
      diagnosticArtifacts: 3,
      metrics: 1,
      decisionRecords: 1,
    },
    totalWords: { min: 2400, max: 3000 },
    titleGuidance:
      'Concrete and countable, anchored on the failures ' +
      '(e.g. "Five Production Failures That Shaped My EKS Platform").',
    sections: [
      {
        name: 'tldr',
        budgetShare: 0.04,
        instruction: 'Per core TL;DR rules.',
      },
      {
        name: 'context',
        budgetShare: 0.16,
        instruction:
          'The minimum architecture needed to understand the failures. ' +
          'Max 1 diagram. No implementation walkthrough.',
      },
      {
        name: 'failures',
        budgetShare: 0.58,
        consumes: 'failureNarratives',
        instruction:
          'The spine. Each failure: symptom → diagnosis → fix → one ' +
          'transferable rule. Order by narrative strength. Max 1 callout ' +
          'per failure. Use every KB metric attached to a failure.',
      },
      {
        name: 'diagnostics',
        budgetShare: 0.13,
        consumes: 'diagnosticArtifacts',
        instruction:
          '"How to Diagnose These Yourself." Zero recap. Real error ' +
          'strings, exact inspection commands, annotated output from the KB.',
      },
      {
        name: 'lessons',
        budgetShare: 0.09,
        instruction:
          'Transferable principles plus forward roadmap (signals ongoing ' +
          'ownership). No new claims without KB evidence.',
      },
    ],
  },
  {
    id: 'deep-dive',
    displayName: 'Deep-dive technical explainer',
    minimums: { decisionRecords: 2, deepLinks: 2 },
    weights: {
      decisionRecords: 4,
      metrics: 3,
      deepLinks: 1,
      failureNarratives: 1,
      diagnosticArtifacts: 1,
    },
    totalWords: { min: 2200, max: 3200 },
    titleGuidance:
      'Name the mechanism and the outcome ' +
      '(e.g. "How Tiered Enrichment Cut Ingestion Cost 3x"). No listicle framing.',
    sections: [
      {
        name: 'tldr',
        budgetShare: 0.04,
        instruction: 'Per core TL;DR rules.',
      },
      {
        name: 'problem',
        budgetShare: 0.14,
        instruction:
          'The concrete problem, quantified from KB metrics. Why the ' +
          'obvious approach fails.',
      },
      {
        name: 'mechanism',
        budgetShare: 0.42,
        consumes: 'decisionRecords',
        instruction:
          'How it works, layer by layer. Every design choice paired with ' +
          'the decision record: what was considered, what was chosen, why.',
      },
      {
        name: 'evidence',
        budgetShare: 0.22,
        consumes: 'metrics',
        instruction:
          'Measured results: before/after numbers, costs, latencies from ' +
          'the KB. If a claimed benefit has no KB measurement, present it ' +
          'as expected, not observed.',
      },
      {
        name: 'limits',
        budgetShare: 0.1,
        instruction:
          'Where the approach breaks down, known debt, open questions. ' +
          'Honesty here is the credibility engine of the whole piece.',
      },
      {
        name: 'lessons',
        budgetShare: 0.08,
        instruction: 'Transferable principles and next steps.',
      },
    ],
  },
  {
    id: 'comparison',
    displayName: 'Comparison / evaluation',
    minimums: { comparisons: 1, metrics: 3 },
    weights: { comparisons: 5, metrics: 3, decisionRecords: 2 },
    totalWords: { min: 2000, max: 2800 },
    titleGuidance:
      'Name both alternatives and the decision axis ' +
      '(e.g. "Step Functions vs Kubernetes Jobs for Linear LLM Pipelines").',
    sections: [
      {
        name: 'tldr',
        budgetShare: 0.05,
        instruction:
          'Include the verdict and its single biggest condition upfront.',
      },
      {
        name: 'criteria',
        budgetShare: 0.12,
        instruction:
          'The evaluation axes and why they were chosen. Criteria must ' +
          "come from the KB's actual decision context, not a generic rubric.",
      },
      {
        name: 'evaluation',
        budgetShare: 0.5,
        consumes: 'comparisons',
        instruction:
          'Alternative-by-alternative against the criteria, with KB ' +
          'measurements. Steelman the option not chosen — a strawman ' +
          'comparison is a groundedness defect.',
      },
      {
        name: 'verdict',
        budgetShare: 0.2,
        consumes: 'decisionRecords',
        instruction:
          'The decision, its conditions, and when the opposite choice is ' +
          'correct. A verdict without a reversal condition is incomplete.',
      },
      {
        name: 'lessons',
        budgetShare: 0.13,
        instruction: 'Transferable evaluation method, not just the result.',
      },
    ],
  },
  {
    id: 'build-log',
    displayName: 'Build log / tutorial',
    minimums: { stepSequences: 1, diagnosticArtifacts: 1 },
    weights: {
      stepSequences: 5,
      diagnosticArtifacts: 2,
      metrics: 1,
      failureNarratives: 2,
    },
    totalWords: { min: 1800, max: 2600 },
    titleGuidance:
      'Outcome-first, honest about scope ' +
      '(e.g. "Standing Up ArgoCD App-of-Apps on EKS, Start to Reconcile").',
    sections: [
      {
        name: 'tldr',
        budgetShare: 0.05,
        instruction:
          'What the reader will have at the end, prerequisites, honest ' +
          'time estimate from the KB if measured.',
      },
      {
        name: 'steps',
        budgetShare: 0.6,
        consumes: 'stepSequences',
        instruction:
          'The ordered sequence from the KB. Every step: the command or ' +
          'config, what it does, and how to verify it worked before ' +
          'moving on. Verification is not optional.',
      },
      {
        name: 'pitfalls',
        budgetShare: 0.2,
        consumes: 'failureNarratives',
        instruction:
          'Real failures hit during the build, with the exact error and ' +
          'the fix. Only KB-evidenced pitfalls — never generic warnings.',
      },
      {
        name: 'lessons',
        budgetShare: 0.15,
        instruction: 'What to do differently, and the next extension.',
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export interface SelectionResult {
  archetype: Archetype;
  score: number;
  eligible: boolean;
  /** Sections whose consumed evidence is thin (< 2 units). */
  gapWarnings: string[];
  /** Non-empty when no archetype met its minimums. */
  fallbackReason?: string;
}

export function scoreArchetype(
  a: Archetype,
  inv: EvidenceInventory,
): number {
  let score = 0;
  for (const [key, weight] of Object.entries(a.weights)) {
    score += (inv[key as keyof EvidenceInventory] ?? 0) * (weight ?? 0);
  }
  return score;
}

export function meetsMinimums(
  a: Archetype,
  inv: EvidenceInventory,
): boolean {
  return Object.entries(a.minimums).every(
    ([key, min]) => (inv[key as keyof EvidenceInventory] ?? 0) >= (min ?? 0),
  );
}

/**
 * Deterministic archetype selection from the evidence inventory.
 *
 * Eligible archetypes (all minimums met) compete on weighted score. If none
 * is eligible, the highest-scoring archetype is returned with
 * eligible=false and a fallbackReason — the pipeline should route this to
 * human review rather than generating, because every archetype would exert
 * fabrication pressure on the missing evidence.
 */
export function selectArchetype(inv: EvidenceInventory): SelectionResult {
  const scored = ARCHETYPES.map((a) => ({
    a,
    score: scoreArchetype(a, inv),
    eligible: meetsMinimums(a, inv),
  })).sort((x, y) => y.score - x.score);

  const winner = scored.find((s) => s.eligible) ?? scored[0];

  // A for-loop narrows `consumes` (keyof | undefined) without a non-null
  // assertion (SonarLint S4325) or an index cast.
  const gapWarnings: string[] = [];
  for (const s of winner.a.sections) {
    const key = s.consumes;
    if (key && (inv[key] ?? 0) < 2) {
      gapWarnings.push(
        `Section "${s.name}" consumes ${key} but inventory has ` +
          `${inv[key] ?? 0} unit(s) — expect a short section or an ` +
          `EVIDENCE_GAP marker.`,
      );
    }
  }

  return {
    archetype: winner.a,
    score: winner.score,
    eligible: winner.eligible,
    gapWarnings,
    fallbackReason: winner.eligible
      ? undefined
      : 'No archetype met its evidence minimums. Do not generate — ' +
        'route to human review or extend KB retrieval.',
  };
}
