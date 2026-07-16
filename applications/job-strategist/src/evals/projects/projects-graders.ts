/**
 * @format
 * Projects-agent per-phase eval - offline structural graders.
 *
 * These reuse the exact predicates the runtime projects lane applies
 * (`validateProjectsProvenance`, `assembleProjects`, `scoreProjectsCoverage`,
 * `scoreSummaryCoverage`, `stampProjectDescription`) so "eval says good" and
 * "guard accepts" can never drift. No Bedrock call - pure, deterministic
 * checks against a fixed ProjectsEvalInput.
 *
 * `assembled` is the RENDERED final section handed to the fixture separately
 * from `output`/`pool` -- in the real pipeline this is what `assembleProjects`
 * produces and what ends up in the resume. Every fixture except the dedicated
 * quote-fidelity adversarial sets it to a fresh `assembleProjects(output, pool)`
 * call, so it is tautologically correct there; the adversarial supplies a
 * deliberately retyped copy to prove `quoteFidelityGrader` actually reads it.
 */
import type { RepoCurrentFact, ProjectPoolEntry } from '../../agents/evidence/project-agent-inputs.js';
import { scoreProjectsCoverage } from '../../agents/writer/projects-ats-flow.js';
import { stampProjectDescription } from '../../agents/writer/projects-description.js';
import { assembleProjects, PROJECTS_MAX_BULLETS_PER_ENTRY, validateProjectsProvenance } from '../../agents/writer/projects-provenance.js';
import { isCurated, type ProjectsAgentOutput } from '../../agents/writer/projects-schema.js';
import type { ExperienceAtsTarget } from '../../ats/gate/experience-ats-targets.js';
import { scoreSummaryCoverage } from '../../ats/gate/summary-coverage.js';
import { mkResult, type GraderResult } from '../graders.js';

/** The exact input the projects phase produces + the rendered artefact + the
 *  context it was graded against. */
export interface ProjectsEvalInput {
    readonly output: ProjectsAgentOutput;
    readonly pool: readonly ProjectPoolEntry[];
    readonly assembled: ReturnType<typeof assembleProjects>;
    readonly atsTargets: readonly ExperienceAtsTarget[];
}

/** Deterministic provenance rules - reuses the runtime validator, does not re-check rules. */
export function provenanceGrader(i: ProjectsEvalInput): GraderResult {
    return mkResult('provenance', validateProjectsProvenance(i.output, i.pool));
}

/**
 * Every curated-id highlight's ASSEMBLED text must be byte-identical to what
 * `assembleProjects` resolves for that same output/pool -- guards against a
 * retyped, truncated, or otherwise mutated rendering ever reaching the user
 * even though the underlying citation was valid.
 */
export function quoteFidelityGrader(i: ProjectsEvalInput): GraderResult {
    const truth = assembleProjects(i.output, i.pool);
    const failures: string[] = [];
    i.output.entries.forEach((entry, ei) => {
        const truthEntry = truth[ei];
        const givenEntry = i.assembled[ei];
        entry.highlights.forEach((h, hi) => {
            if (!isCurated(h)) return;
            const truthText = truthEntry?.highlights[hi];
            const givenText = givenEntry?.highlights[hi];
            if (truthText === undefined || givenText === undefined || truthText !== givenText) {
                failures.push(`quote_mismatch:${entry.name}:${h.bulletId}`);
            }
        });
    });
    return mkResult('quoteFidelity', failures);
}

/**
 * Composition quality: composed bullets stay <= the per-entry bullet cap
 * (Task 3: raised from a separate `<=2/project` allowance to
 * `PROJECTS_MAX_BULLETS_PER_ENTRY` -- the SAME cap `bullet_count` enforces,
 * imported from `projects-provenance.ts` so eval and runtime can never
 * drift), every cited source belongs to the SAME project's pool, and -- the
 * staleness-appropriateness check -- each composed bullet's cited
 * repo-current fact's skill must NOT already be answerable by any of the
 * project's curated bullets (per-bullet `scoreSummaryCoverage` of that
 * single skill against each curated text). A composed bullet answering an
 * already-curated skill means the model manufactured a redundant fact
 * instead of using the two-lane pool correctly.
 *
 * The cap is ALSO enforced by `validateProjectsProvenance` (defence in
 * depth, not a coincidence): a fixture that violates the cap legitimately
 * fails BOTH `provenanceGrader` and `compositionGrader`.
 */
export function compositionGrader(i: ProjectsEvalInput): GraderResult {
    const failures: string[] = [];
    const poolByName = new Map(i.pool.map((p) => [p.name, p]));
    for (const entry of i.output.entries) {
        const poolEntry = poolByName.get(entry.name);
        if (!poolEntry) continue; // unknown-project is provenanceGrader's job
        const ownIds = new Set<string>([...poolEntry.curated.map((c) => c.id), ...poolEntry.repoCurrent.map((r) => r.id)]);
        const repoCurrentById = new Map<string, RepoCurrentFact>(poolEntry.repoCurrent.map((r) => [r.id, r]));
        const composed = entry.highlights.filter((h): h is { text: string; sources: string[] } => !isCurated(h));

        if (composed.length > PROJECTS_MAX_BULLETS_PER_ENTRY) failures.push(`composed_cap:${entry.name}:${composed.length}`);

        composed.forEach((h, idx) => {
            for (const s of h.sources) {
                if (!ownIds.has(s)) {
                    failures.push(`out_of_project_citation:${entry.name}:${idx}:${s}`);
                    continue;
                }
                const fact = repoCurrentById.get(s);
                if (!fact) continue; // cites a curated id -- no "skill" to re-check here
                const target = { skill: fact.skill, source: 'hard' as const, verdict: 'verified' as const };
                const alreadyCurated = poolEntry.curated.some((c) => scoreSummaryCoverage(c.text, [target]).covered > 0);
                if (alreadyCurated) failures.push(`composed_skill_already_curated:${entry.name}:${fact.skill}`);
            }
        });
    }
    return mkResult('composition', failures);
}

/**
 * ATS coverage: a well-composed projects section should surface at least
 * min(2, N) of its attainable targets. Delegates to `scoreProjectsCoverage`
 * (projects-ats-flow.ts) -- the SAME term-tolerant `experienceTermMatch`
 * primitive the runtime resolver scores coverage with, over HIGHLIGHTS ONLY
 * (`output`/`pool`, not `assembled`). This grader previously scored the
 * RENDERED text (description + highlights) via the summary lane's strict
 * adjacent-phrase `scoreSummaryCoverage` -- a different predicate than the
 * runtime ever applies to projects, so "eval says good" could drift from
 * "guard accepts" in either direction (a description-only keyword mention
 * passing here while the runtime, which never scores descriptions, saw no
 * coverage at all; or a genuinely on-topic but non-adjacent highlight failing
 * here while the runtime's term-match credited it). Vacuously passes when a
 * fixture set no targets.
 */
export function atsCoverageGrader(i: ProjectsEvalInput): GraderResult {
    const targets = i.atsTargets;
    if (targets.length === 0) return mkResult('atsCoverage', []);
    const { covered } = scoreProjectsCoverage(i.output, i.pool, targets);
    const need = Math.min(2, targets.length);
    return mkResult(
        'atsCoverage',
        covered >= need ? [] : [`projects cover only ${covered}/${targets.length} ATS targets (need >=${need})`],
    );
}

/**
 * Description quality, checked WITH the runtime primitive itself
 * (`stampProjectDescription`, projects-description.ts -- Task 2's SOLE
 * description producer on every path) rather than a parallel restatement of
 * its rules: a valid description must be non-empty and a FIXED POINT of the
 * stamp at its 80-word default cap -- `stampProjectDescription(description,
 * 80) === description.trim()`. Every genuine stamp output is idempotent
 * (single paragraph, whole sentences within the cap, an over-cap single
 * sentence word-sliced and re-terminated with '.'), so any description the
 * stamp would ALTER -- over-budget, multi-paragraph, or a mid-sentence
 * truncation the stamp would re-trim -- cannot have been produced by it and
 * fails. The runtime validator deliberately has NO description rules (the
 * field is system-stamped post-validation -- see `validateEntry`,
 * projects-provenance.ts); this grader checks the STAMPED artefact the
 * fixture carries, a surface the runtime guard never re-reads.
 */
export function descriptionGrader(i: ProjectsEvalInput): GraderResult {
    const poolNames = new Set(i.pool.map((p) => p.name));
    const failures = i.output.entries.flatMap((entry) => {
        if (!poolNames.has(entry.name)) return []; // unknown-project is provenanceGrader's job
        const trimmed = entry.description.trim();
        if (trimmed.length === 0) return [`description_empty:${entry.name}`];
        if (stampProjectDescription(entry.description, 80) !== trimmed) return [`description_not_stamp_shaped:${entry.name}`];
        return [];
    });
    return mkResult('description', failures);
}

/** All structural graders, in display order. */
export const PROJECTS_GRADERS = [
    provenanceGrader,
    quoteFidelityGrader,
    compositionGrader,
    atsCoverageGrader,
    descriptionGrader,
] as const;

/** Run every grader; overall pass = all pass. */
export function runProjectsGraders(i: ProjectsEvalInput): { pass: boolean; results: GraderResult[] } {
    const results = PROJECTS_GRADERS.map((g) => g(i));
    return { pass: results.every((r) => r.pass), results };
}
