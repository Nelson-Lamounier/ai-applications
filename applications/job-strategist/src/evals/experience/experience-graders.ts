/**
 * @format
 * Experience-agent per-phase eval - offline structural graders.
 *
 * These reuse the exact predicates the runtime experience lane applies
 * (`validateExperienceProvenance`, `scoreSummaryCoverage`, `numbersIn`) so "eval
 * says good" and "guard accepts" can never drift. No Bedrock call - pure,
 * deterministic checks against a fixed ExperienceEvalInput.
 */
import { numbersIn } from '../../agents/quality/guards/text.js';
import { joinExperienceText } from '../../agents/writer/experience-ats-flow.js';
import {
    validateExperienceProvenance,
    type IndexedCareerLine,
    type RosterEntry,
} from '../../agents/writer/experience-provenance.js';
import type { ExperienceAgentOutput } from '../../agents/writer/experience-schema.js';
import type { ExperienceAtsTarget } from '../../ats/gate/experience-ats-targets.js';
import { scoreSummaryCoverage } from '../../ats/gate/summary-coverage.js';
import { mkResult, type GraderResult } from '../graders.js';

/** The exact input the experience phase produces + the context it was graded against. */
export interface ExperienceEvalInput {
    readonly output: ExperienceAgentOutput;
    readonly roster: readonly RosterEntry[];
    readonly careerLines: readonly IndexedCareerLine[];
    readonly atsTargets: readonly ExperienceAtsTarget[];
    readonly allowedNumbers: readonly string[]; // ledger + source-line numbers
}

/** Deterministic provenance rules - reuses the runtime validator, does not re-check rules. */
export function provenanceGrader(i: ExperienceEvalInput): GraderResult {
    return mkResult('provenance', validateExperienceProvenance(i.output, i.roster, i.careerLines));
}

/**
 * No invented numbers: every number token in every bullet must appear in the
 * caller-supplied `allowedNumbers` (ledger/source-line numbers already vetted)
 * OR in one of that bullet's cited career-line sources.
 */
export function noFabricationGrader(i: ExperienceEvalInput): GraderResult {
    const allowed = new Set(i.allowedNumbers);
    const lineById = new Map(i.careerLines.map((l) => [l.id, l]));
    const failures: string[] = [];
    for (const role of i.output.roles) {
        for (const bullet of role.highlights) {
            const sourceNums = new Set<string>();
            for (const s of bullet.sources) {
                const line = lineById.get(s);
                if (line) for (const n of numbersIn(line.text)) sourceNums.add(n);
            }
            for (const n of numbersIn(bullet.text)) {
                if (!allowed.has(n) && !sourceNums.has(n)) {
                    failures.push(`fabricated number "${n}" in ${role.company} bullet: ${bullet.text}`);
                }
            }
        }
    }
    return mkResult('noFabrication', failures);
}

/**
 * ATS coverage: an ATS-aware experience section should surface at least
 * min(2, N) of its attainable targets across all bullets. Vacuously passes
 * when a fixture set no targets.
 */
export function atsCoverageGrader(i: ExperienceEvalInput): GraderResult {
    const targets = i.atsTargets;
    if (targets.length === 0) return mkResult('atsCoverage', []);
    const { covered } = scoreSummaryCoverage(joinExperienceText(i.output), targets);
    const need = Math.min(2, targets.length);
    return mkResult(
        'atsCoverage',
        covered >= need ? [] : [`experience covers only ${covered}/${targets.length} ATS targets (need >=${need})`],
    );
}

/** Voice: every bullet stays a single punchy line - short, and not a metrics dump. */
export function voiceGrader(i: ExperienceEvalInput): GraderResult {
    const failures: string[] = [];
    for (const role of i.output.roles) {
        for (const bullet of role.highlights) {
            const words = bullet.text.trim().split(/\s+/).filter(Boolean).length;
            if (words > 32) failures.push(`${role.company} bullet is ${words} words (>32): ${bullet.text}`);
            const numCount = numbersIn(bullet.text).size;
            if (numCount > 2) failures.push(`${role.company} bullet has ${numCount} number tokens (>2): ${bullet.text}`);
        }
    }
    return mkResult('voice', failures);
}

/**
 * Reorder: within a role, whichever bullet(s) cover an ATS target, the LEAD
 * bullet (the first one, read first by a recruiter/ATS) must be one of them.
 * Vacuous per role (and overall, when no target is ever covered).
 */
export function reorderGrader(i: ExperienceEvalInput): GraderResult {
    const targets = i.atsTargets;
    const failures: string[] = [];
    for (const role of i.output.roles) {
        if (role.highlights.length === 0) continue;
        const coveringIdx = role.highlights
            .map((b, idx) => ({ idx, covers: scoreSummaryCoverage(b.text, targets).covered > 0 }))
            .filter((x) => x.covers)
            .map((x) => x.idx);
        if (coveringIdx.length === 0) continue;
        if (!coveringIdx.includes(0)) {
            failures.push(
                `${role.company}: lead bullet does not cover any ATS target (covering bullets at index ${coveringIdx.join(',')})`,
            );
        }
    }
    return mkResult('reorder', failures);
}

/** All structural graders, in display order. */
export const EXPERIENCE_GRADERS = [
    provenanceGrader,
    noFabricationGrader,
    atsCoverageGrader,
    voiceGrader,
    reorderGrader,
] as const;

/** Run every grader; overall pass = all pass. */
export function runExperienceGraders(i: ExperienceEvalInput): { pass: boolean; results: GraderResult[] } {
    const results = EXPERIENCE_GRADERS.map((g) => g(i));
    return { pass: results.every((r) => r.pass), results };
}
