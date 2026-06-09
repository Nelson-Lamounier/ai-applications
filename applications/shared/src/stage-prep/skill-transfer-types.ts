/** @format */
export type CandidateTier = 'demonstrated' | 'claimed' | 'declared';
export type SkillTier = CandidateTier | 'gap';
export type CandidateSource =
  | 'component' | 'decision' | 'stack_item' | 'tag' | 'tech_evidence' | 'dsa_evidence';

/** One grounded project row that may evidence a JD skill. `id` is the real row id
 *  (or `${projectId}:${tag}` for tags, which have no own id). */
export interface SkillCandidate {
  readonly projectId: string;
  readonly projectName: string;
  readonly source: CandidateSource;
  readonly tier: CandidateTier;
  readonly id: string;
  readonly label: string;
  readonly fileLine?: string;
}
export interface SkillCandidateSet {
  readonly jdSkill: string;
  readonly candidates: readonly SkillCandidate[];
}

/** Raw project evidence for one user (what the repository returns). */
export interface ProjectEvidenceInput {
  readonly projects:    readonly { id: string; name: string; tagline?: string | null; pitch?: string | null }[];
  readonly components:  readonly { id: string; projectId: string; name: string; kind: string }[];
  readonly decisions:   readonly { id: string; projectId: string; title: string; decision: string | null }[];
  readonly stackItems:  readonly { id: string; projectId: string; name: string; category: string }[];
  readonly tags:        readonly { projectId: string; tag: string }[];
  readonly repoEvidence: readonly {
    projectId: string; source: 'tech_evidence' | 'dsa_evidence';
    id: string; rawName: string; fileLine: string;
  }[];
}

/** Final per-skill mapping emitted by the coach + sanitised by validateSkillTransfer. */
export interface SkillTransferEntry {
  readonly jdSkill: string;
  readonly tier: SkillTier;
  readonly projectId: string | null;
  readonly projectName: string | null;
  readonly evidenceRefs: readonly { source: string; id: string; label: string; fileLine?: string }[];
  readonly narrative: string;
}
