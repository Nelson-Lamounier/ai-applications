/** @format */
import type { SkillEvidenceEntry } from '@bedrock/shared';
import { matchTier1 } from '../matching/keyword-match.js';
import type { IndexedCareerLine } from '../../agents/writer/experience-provenance.js';
import { experienceTermMatch } from './experience-coverage.js';
import type { SummaryAtsTarget } from './summary-ats-targets.js';

export interface ExperienceAtsTarget extends SummaryAtsTarget {
  /** The JD requirement this target belongs to -- lets the message group a
   *  composite requirement ("Networking ... (DNS, TCP/IP, SSL/TLS)") with its
   *  attainable members. */
  readonly requirement: string;
  /** Career-line ids (`c{i}.h{j}`) whose text term-matches this target by the
   *  same `experienceTermMatch` rule the coverage scorer uses -- the evidence
   *  a bullet may cite instead of reproducing the target's exact wording (see
   *  experience-coverage.ts's scoreExperienceCoverage). */
  readonly anchors: string[];
}

interface JdLike {
  readonly hardRequirements: ReadonlyArray<{ skill: string; disqualifying?: boolean }>;
}

/** Career lines whose text term-matches `skill` -- the anchor evidence for a
 *  target, computed with the exact same rule `scoreExperienceCoverage` uses
 *  to credit a bullet, so "this target is genuinely supported" means one
 *  thing at selection time and at scoring time. */
function anchorsFor(skill: string, careerLines: readonly IndexedCareerLine[]): string[] {
  return careerLines.filter((l) => experienceTermMatch(skill, l.text)).map((l) => l.id);
}

/** Top-N attainable (verified/transferable, never gap) JD must-have targets for
 *  the experience section, requirement-stamped and evidence-anchored. Same
 *  matching semantics as selectSummaryAtsTargets (bidirectional matchTier1 +
 *  exact lowercase), wider limit, and the ledger-tool side is the emitted
 *  skill so composite JD requirements contribute each attainable member. */
export function selectExperienceAtsTargets(
  ledger: readonly SkillEvidenceEntry[],
  jd: JdLike,
  careerLines: readonly IndexedCareerLine[],
  limit = 6,
): ExperienceAtsTarget[] {
  const attainable = ledger.filter((e) => e.status === 'verified' || e.status === 'transferable');
  const targets: ExperienceAtsTarget[] = [];
  for (const e of attainable) {
    const req = jd.hardRequirements.find(
      (r) =>
        matchTier1(r.skill, e.tool.toLowerCase()) ||
        matchTier1(e.tool, r.skill.toLowerCase()) ||
        r.skill.toLowerCase() === e.tool.toLowerCase(),
    );
    if (!req) continue;
    targets.push({
      skill: e.tool,
      source: req.disqualifying ? 'disqualifying' : 'hard',
      verdict: e.status as 'verified' | 'transferable',
      requirement: req.skill,
      anchors: anchorsFor(e.tool, careerLines),
    });
  }
  const rank = { disqualifying: 0, hard: 1, soft: 2 } as const;
  targets.sort(
    (a, b) =>
      rank[a.source] - rank[b.source] ||
      (a.verdict === 'verified' ? 0 : 1) - (b.verdict === 'verified' ? 0 : 1),
  );
  return targets.slice(0, limit);
}
