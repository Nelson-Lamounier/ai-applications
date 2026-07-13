/**
 * @format
 * Education / degree reconciliation — deterministic.
 *
 * A JD degree requirement (e.g. "Bachelor's in Computer Science, or a relevant technical
 * field, or equivalent practical experience") is extracted into softRequirements but was
 * never reconciled against the candidate's actual education — so a Higher Diploma in
 * Computing got silently dropped: neither credited nor flagged. The matcher's
 * verified/partial/gap machinery is skill/tool-centric and has no slot for a degree.
 *
 * This closes that gap deterministically: detect the degree requirement, match it against
 * the candidate's education entries, and emit EXACTLY ONE answer (verified / partial / gap)
 * so a degree line is never silently dropped again. Pure; fail-open (null on no signal).
 */

import type { VerifiedMatch, PartialMatch, SkillGap, JobRequirement } from '@bedrock/shared';
import type { EducationEntry } from '../../agents/evidence/career-history.js';

// A requirement that is actually about a degree/qualification (not e.g. "degree of automation").
const DEGREE_REQ_RE = /\b(bachelor'?s?|master'?s?|degree|diploma|b\.?sc|b\.?eng|graduate|undergraduate|qualification in)\b/i;
// Fields that count as a "relevant technical field". Stems are PREFIX-matched (no trailing
// word boundary), so "comput" matches Computer/Computing, "engineer" matches Engineering, etc.
const TECHNICAL_FIELD_RE = /\b(comput|software|engineer|informatics|information technology|data|cloud|devops|electronic|cyber|network|mathematic|science|\bit\b)/i;
// The JD permits equivalents (relevant field / practical experience), not only a named degree.
const ALLOWS_EQUIV_RE = /relevant technical field|equivalent|or another|practical experience|or related/i;

export interface DegreeReconcileDeps {
    readonly hardRequirements: ReadonlyArray<JobRequirement>;
    readonly softRequirements: ReadonlyArray<JobRequirement>;
    readonly education: ReadonlyArray<EducationEntry>;
}

/** Exactly one of these is set when a degree requirement exists; null when the JD asks for none. */
export interface DegreeReconcileResult {
    readonly verified?: VerifiedMatch;
    readonly partial?: PartialMatch;
    readonly gap?: SkillGap;
    /** The matched requirement's skill text — used to dedupe any LLM-emitted degree entry. */
    readonly requirementSkill: string;
}

const reqText = (r: JobRequirement): string => `${r.skill} ${r.context ?? ''}`;
const degreeList = (es: ReadonlyArray<EducationEntry>): string =>
    es.map((e) => [e.degree, e.institution].filter(Boolean).join(', ')).join('; ');

/** Find the JD's degree/education requirement, if any (hard takes precedence over soft). */
function findDegreeRequirement(
    hard: ReadonlyArray<JobRequirement>,
    soft: ReadonlyArray<JobRequirement>,
): { req: JobRequirement; isHard: boolean } | null {
    const h = hard.find((r) => DEGREE_REQ_RE.test(reqText(r)));
    if (h) return { req: h, isHard: true };
    const s = soft.find((r) => DEGREE_REQ_RE.test(reqText(r)));
    if (s) return { req: s, isHard: false };
    return null;
}

/**
 * A relevant technical-field qualification is present: VERIFIED when the JD allows a relevant
 * field/equivalent (the usual "preferred" case), else PARTIAL framed as equivalent to a named degree.
 */
function relevantFieldResult(
    req: JobRequirement,
    relevant: ReadonlyArray<EducationEntry>,
    allowsEquiv: boolean,
): DegreeReconcileResult {
    if (allowsEquiv) {
        return {
            requirementSkill: req.skill,
            verified: {
                skill: req.skill,
                sourceCitation: `${degreeList(relevant)} — a relevant technical field, satisfying "${req.skill}".`,
                depth: 'working', recency: 'completed', evidenceFiles: [],
            },
        };
    }
    return {
        requirementSkill: req.skill,
        partial: {
            skill: req.skill,
            gapDescription: `The JD names a specific degree; the candidate holds a relevant-technical-field qualification rather than that exact title.`,
            transferableFoundation: `${degreeList(relevant)} — a relevant technical field, equivalent in substance to "${req.skill}".`,
            framingSuggestion: `Lead with the technical-field qualification (${degreeList(relevant)}) plus hands-on production experience as equivalent.`,
            evidenceFiles: [],
        },
    };
}

/**
 * Reconcile the JD degree requirement against the candidate's education.
 *  - relevant technical-field qualification present → VERIFIED (named degree OR equivalent field).
 *  - a degree present but field-mismatched while the JD allows equivalents → PARTIAL (lean on field/experience).
 *  - no relevant education → GAP (hard/soft per the requirement; minor when equivalents are allowed).
 */
export function reconcileDegree(deps: DegreeReconcileDeps): DegreeReconcileResult | null {
    const found = findDegreeRequirement(deps.hardRequirements, deps.softRequirements);
    if (!found) return null;
    const { req, isHard } = found;
    const allowsEquiv = ALLOWS_EQUIV_RE.test(reqText(req));

    const withDegree = deps.education.filter((e) => e.degree.trim().length > 0);
    const relevant = withDegree.filter((e) => TECHNICAL_FIELD_RE.test(e.degree));

    if (relevant.length > 0) return relevantFieldResult(req, relevant, allowsEquiv);

    if (withDegree.length > 0 && allowsEquiv) {
        // Has a degree, but not a technical field — the JD allows equivalent practical experience.
        return {
            requirementSkill: req.skill,
            partial: {
                skill: req.skill,
                gapDescription: `Candidate holds a degree (${degreeList(withDegree)}) outside the named technical fields.`,
                transferableFoundation: `The JD accepts equivalent practical experience; the candidate's hands-on technical record bridges the field difference.`,
                framingSuggestion: `Frame the degree alongside production experience as "equivalent practical experience".`,
                evidenceFiles: [],
            },
        };
    }

    // No relevant education on record.
    return {
        requirementSkill: req.skill,
        gap: {
            skill: req.skill,
            gapType: isHard ? 'hard' : 'soft',
            impactSeverity: allowsEquiv ? 'minor' : isHard ? 'significant' : 'minor',
            disqualifyingAssessment: allowsEquiv
                ? `No matching degree on record, but the JD allows equivalent practical experience — lean on the hands-on technical record.`
                : `The JD requires ${req.skill} and no matching qualification is on record.`,
        },
    };
}

/**
 * Apply the reconciled degree answer to a research matching, idempotently: drop any existing
 * entry (verified/partial/gap) for the same degree requirement, then insert the deterministic
 * one. A no-op when the JD asks for no degree. Pure — returns a new matching.
 */
export function applyDegreeReconcile<
    M extends { verifiedMatches: VerifiedMatch[]; partialMatches: PartialMatch[]; gaps: SkillGap[] },
>(matching: M, deps: DegreeReconcileDeps): { matching: M; result: DegreeReconcileResult | null } {
    const result = reconcileDegree(deps);
    if (!result) return { matching, result: null };

    const sameReq = (skill: string): boolean => DEGREE_REQ_RE.test(skill);
    const next: M = {
        ...matching,
        verifiedMatches: matching.verifiedMatches.filter((v) => !sameReq(v.skill)),
        partialMatches: matching.partialMatches.filter((p) => !sameReq(p.skill)),
        gaps: matching.gaps.filter((g) => !sameReq(g.skill)),
    };
    if (result.verified) next.verifiedMatches = [...next.verifiedMatches, result.verified];
    if (result.partial) next.partialMatches = [...next.partialMatches, result.partial];
    if (result.gap) next.gaps = [...next.gaps, result.gap];
    return { matching: next, result };
}
