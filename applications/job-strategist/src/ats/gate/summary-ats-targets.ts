/** @format */
import type { SkillEvidenceEntry } from '@bedrock/shared';
import { matchTier1 } from '../matching/keyword-match.js';

export interface SummaryAtsTarget {
  readonly skill: string;
  readonly source: 'disqualifying' | 'hard' | 'soft';
  readonly verdict: 'verified' | 'transferable';
}

interface JdLike {
  readonly hardRequirements: ReadonlyArray<{ skill: string; disqualifying?: boolean }>;
}

/** Top-N attainable (verified/transferable, never gap) JD must-haves for the
 *  summary, ordered disqualifying -> hard -> soft, then verified before transferable. */
export function selectSummaryAtsTargets(
  ledger: readonly SkillEvidenceEntry[],
  jd: JdLike,
  limit = 3,
): SummaryAtsTarget[] {
  const hard = new Map(jd.hardRequirements.map((r) => [r.skill.toLowerCase(), r]));
  const attainable = ledger.filter((e) => e.status === 'verified' || e.status === 'transferable');
  const targets: SummaryAtsTarget[] = [];
  for (const e of attainable) {
    const req = [...hard.values()].find(
      (r) =>
        matchTier1(r.skill, e.tool.toLowerCase()) ||
        matchTier1(e.tool, r.skill.toLowerCase()) ||
        r.skill.toLowerCase() === e.tool.toLowerCase(),
    );
    if (!req) continue;
    const source = req.disqualifying ? 'disqualifying' : 'hard';
    targets.push({ skill: e.tool, source, verdict: e.status as 'verified' | 'transferable' });
  }
  const rank = { disqualifying: 0, hard: 1, soft: 2 } as const;
  targets.sort(
    (a, b) =>
      rank[a.source] - rank[b.source] ||
      (a.verdict === 'verified' ? 0 : 1) - (b.verdict === 'verified' ? 0 : 1),
  );
  return targets.slice(0, limit);
}
