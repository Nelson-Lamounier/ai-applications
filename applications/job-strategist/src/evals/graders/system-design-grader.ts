/** @format */
import { mkResult } from '../graders.js';
import type { Grader } from '../graders.js';
import type { ConcernCoverage, SystemDesignWalkthroughCard } from '@bedrock/shared';

/** Every JD-relevant concern must have a card. */
function coverageFailures(coverage: ConcernCoverage, cards: readonly SystemDesignWalkthroughCard[]): string[] {
    const covered = new Set(cards.map(c => c.concernId));
    return coverage.detected
        .filter(d => d.relevantToJd && !covered.has(d.concernId))
        .map(d => `no card for relevant concern: ${d.concernId}`);
}

/** A single card: known concern, no invented evidence ids, gap cards carry no evidence. */
function cardFailures(card: SystemDesignWalkthroughCard, allowed: Set<string> | undefined): string[] {
    if (!allowed) return [`card for unknown concern: ${card.concernId}`];
    const f = card.evidenceRefs.filter(r => !allowed.has(r.id)).map(r => `invented evidence id "${r.id}" for ${card.concernId}`);
    if (card.choiceMade === null && card.evidenceRefs.length > 0) f.push(`gap card "${card.concernId}" must have no evidenceRefs`);
    return f;
}

/**
 * Grounding + coverage + honesty for system-design walkthroughs. Every cited evidence id must
 * exist in the deterministic coverage; every JD-relevant concern must have a card; gap cards
 * (choiceMade=null) must carry no evidence.
 */
export const systemDesignGrader: Grader = (input, output) => {
    if (input.stage !== 'system-design') return mkResult('system-design', []);
    const coverage = (output as { systemDesignCoverage?: ConcernCoverage }).systemDesignCoverage;
    const cards = (output as { systemDesignWalkthrough?: SystemDesignWalkthroughCard[] }).systemDesignWalkthrough ?? [];
    if (!coverage) return mkResult('system-design', ['missing systemDesignCoverage']);

    const refsByConcern = new Map(coverage.detected.map(d => [d.concernId, new Set(d.evidenceRefs.map(r => r.id))]));
    const failures = [
        ...coverageFailures(coverage, cards),
        ...cards.flatMap(card => cardFailures(card, refsByConcern.get(card.concernId))),
    ];
    return mkResult('system-design', failures);
};
