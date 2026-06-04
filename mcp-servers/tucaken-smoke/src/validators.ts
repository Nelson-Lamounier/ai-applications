/** @format */
interface Ref { id: string }
interface Card { concernId: string; choiceMade: string | null; evidenceRefs?: Ref[] }
interface Detected { concernId: string; evidenceRefs?: Ref[] }
interface Coverage { detected: Detected[]; relevantTotal: number; relevantAddressed: number }
interface Coaching { systemDesignCoverage?: Coverage; systemDesignWalkthrough?: Card[] }

export function validateSystemDesign(tier: 'A' | 'B', c: Coaching): { ok: boolean; failures: string[] } {
  const failures: string[] = [];
  const coverage = c.systemDesignCoverage;
  if (!coverage) { failures.push('missing systemDesignCoverage'); return { ok: false, failures }; }
  if (tier === 'A') return { ok: true, failures };

  const refsByConcern = new Map(coverage.detected.map(d => [d.concernId, new Set((d.evidenceRefs ?? []).map(r => r.id))]));
  for (const card of c.systemDesignWalkthrough ?? []) {
    const allowed = refsByConcern.get(card.concernId);
    if (!allowed) { failures.push(`card for unknown concern: ${card.concernId}`); continue; }
    for (const r of card.evidenceRefs ?? []) if (!allowed.has(r.id)) failures.push(`invented evidence id "${r.id}" for ${card.concernId}`);
    if (card.choiceMade === null && (card.evidenceRefs ?? []).length > 0) failures.push(`gap card "${card.concernId}" must carry no evidenceRefs`);
  }
  return { ok: failures.length === 0, failures };
}
