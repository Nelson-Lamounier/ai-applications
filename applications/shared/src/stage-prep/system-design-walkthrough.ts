/** @format */
import type {
  ConcernCoverage, SystemDesignWalkthroughCard, SystemDesignFollowUp,
} from './system-design-concerns-types.js';

const GAP_ARTICULATION =
  'Your project has no evidence for this concern yet. Be honest: describe how you would ' +
  'approach it and bridge from the nearest real decision you made.';

function toGapCard(card: SystemDesignWalkthroughCard): SystemDesignWalkthroughCard {
  const followUps: SystemDesignFollowUp[] = card.followUps.map(f => ({ ...f, status: 'gap' }));
  return {
    concernId: card.concernId, concernQuestion: card.concernQuestion, whyItMatters: card.whyItMatters,
    evidenceRefs: [], choiceMade: null,
    articulation: card.choiceMade === null ? card.articulation : GAP_ARTICULATION,
    followUps, gapGuidance: card.gapGuidance ?? GAP_ARTICULATION,
  };
}

/**
 * Sanitise coach-emitted walkthrough cards against the deterministic detection.
 * Unknown concern → dropped. Any card citing an evidence id not detected for its
 * concern → demoted to an honest gap. Honest gap cards (no evidence, choiceMade=null)
 * pass through. Anti-invention backstop, mirrors validateSkillTransfer.
 */
export function validateSystemDesignWalkthrough(
  cards: readonly SystemDesignWalkthroughCard[],
  coverage: ConcernCoverage,
): SystemDesignWalkthroughCard[] {
  const refsByConcern = new Map(
    coverage.detected.map(d => [d.concernId, new Set(d.evidenceRefs.map(r => r.id))]),
  );
  const out: SystemDesignWalkthroughCard[] = [];
  for (const card of cards) {
    const allowed = refsByConcern.get(card.concernId);
    if (!allowed) continue; // unknown concern → drop
    if (card.choiceMade === null && card.evidenceRefs.length === 0) { out.push(card); continue; }
    const grounded = card.evidenceRefs.length > 0 && card.evidenceRefs.every(r => allowed.has(r.id));
    out.push(grounded ? card : toGapCard(card));
  }
  return out;
}
