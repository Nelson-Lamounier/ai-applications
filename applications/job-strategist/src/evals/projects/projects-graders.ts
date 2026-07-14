/**
 * @format
 * Projects-agent per-phase eval - offline structural graders.
 *
 * These reuse the exact predicates the runtime projects lane applies
 * (`validateProjectsProvenance`, `assembleProjects`, `scoreSummaryCoverage`) so
 * "eval says good" and "guard accepts" can never drift. No Bedrock call - pure,
 * deterministic checks against a fixed ProjectsEvalInput.
 *
 * `assembled` is the RENDERED final section handed to the fixture separately
 * from `output`/`pool` -- in the real pipeline this is what `assembleProjects`
 * produces and what ends up in the resume. Every fixture except the dedicated
 * quote-fidelity adversarial sets it to a fresh `assembleProjects(output, pool)`
 * call, so it is tautologically correct there; the adversarial supplies a
 * deliberately retyped copy to prove `quoteFidelityGrader` actually reads it.
 */
import type { RepoCurrentFact, ProjectPoolEntry } from '../../agents/evidence/project-agent-inputs.js';
import { assembleProjects, validateProjectsProvenance } from '../../agents/writer/projects-provenance.js';
import { isCurated, type ProjectsAgentOutput } from '../../agents/writer/projects-schema.js';
import type { ExperienceAtsTarget } from '../../ats/gate/experience-ats-targets.js';
import { scoreSummaryCoverage } from '../../ats/gate/summary-coverage.js';
import { mkResult, type GraderResult } from '../graders.js';

const MAX_COMPOSED = 2;
const MAX_DESCRIPTION_WORDS = 40;
const MIN_PITCH_OVERLAP = 0.3;

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
 * Composition quality: composed bullets stay <=2/project, every cited source
 * belongs to the SAME project's pool, and -- the staleness-appropriateness
 * check -- each composed bullet's cited repo-current fact's skill must NOT
 * already be answerable by any of the project's curated bullets (per-bullet
 * `scoreSummaryCoverage` of that single skill against each curated text).
 * A composed bullet answering an already-curated skill means the model
 * manufactured a redundant fact instead of using the two-lane pool correctly.
 *
 * The `<=2/project` cap is ALSO enforced by `validateProjectsProvenance`
 * (defence in depth, not a coincidence): a fixture that violates the cap
 * legitimately fails BOTH `provenanceGrader` and `compositionGrader`.
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

        if (composed.length > MAX_COMPOSED) failures.push(`composed_cap:${entry.name}:${composed.length}`);

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
 * min(2, N) of its attainable targets across the RENDERED (assembled) text.
 * Vacuously passes when a fixture set no targets.
 */
export function atsCoverageGrader(i: ProjectsEvalInput): GraderResult {
    const targets = i.atsTargets;
    if (targets.length === 0) return mkResult('atsCoverage', []);
    const joined = i.assembled.flatMap((p) => [p.description, ...p.highlights]).join('. ');
    const { covered } = scoreSummaryCoverage(joined, targets);
    const need = Math.min(2, targets.length);
    return mkResult(
        'atsCoverage',
        covered >= need ? [] : [`projects cover only ${covered}/${targets.length} ATS targets (need >=${need})`],
    );
}

/** Lowercase alnum tokens, length > 3 -- the exact formula `pitchOverlapViolation`
 *  in projects-provenance.ts uses, restated locally so this grader has no
 *  cross-module coupling to the validator's internals. */
function distinctiveTokens(text: string): Set<string> {
    return new Set(text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(/\s+/).filter((t) => t.length > 3));
}

/**
 * Description quality: <=40 words, and >=30% of the pool pitch's distinctive
 * tokens must reappear in the description -- the same formula the runtime
 * validator applies. Re-checking it here as its own grader gives the eval
 * report a dedicated, readable failure line even though `validateProjectsProvenance`
 * enforces the identical rule.
 */
export function descriptionGrader(i: ProjectsEvalInput): GraderResult {
    const failures: string[] = [];
    const poolByName = new Map(i.pool.map((p) => [p.name, p]));
    for (const entry of i.output.entries) {
        const poolEntry = poolByName.get(entry.name);
        if (!poolEntry) continue;
        const words = entry.description.trim().split(/\s+/).filter((w) => w.length > 0);
        if (words.length > MAX_DESCRIPTION_WORDS) failures.push(`description_words:${entry.name}:${words.length}`);

        const pitchTokens = distinctiveTokens(poolEntry.pitch);
        if (pitchTokens.size === 0) continue;
        const descTokens = distinctiveTokens(entry.description);
        let hit = 0;
        for (const t of pitchTokens) if (descTokens.has(t)) hit++;
        if (hit / pitchTokens.size < MIN_PITCH_OVERLAP) failures.push(`pitch_overlap:${entry.name}`);
    }
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
