/**
 * @format
 * Operations-angle evidence wiring -- the pure-ish core of run-pipeline.ts's
 * projects-pool build step, split into its own module (rather than left
 * inline in run-pipeline.ts) specifically so it stays UNIT-TESTABLE:
 * run-pipeline.ts's module graph transitively pulls in pdf-parse ->
 * @napi-rs/canvas (ATS PDF render/parse-back), whose native binding leaves
 * an open GC handle Jest cannot tear down (see the same note on
 * `__tests__/experience-weave-scope.test.ts`) -- importing run-pipeline.ts
 * itself from a Jest file is the thing to avoid, not a design preference.
 *
 * See docs/superpowers/specs/2026-07-16-projects-operations-evidence-design.md.
 */
import type { JdSignal } from '@bedrock/shared';
import { activateThemes } from './operations-themes.js';
import { gatherOperationsEvidence, type RetrievedPassage } from './operations-evidence.js';
import { buildProjectPool, type ProjectAgentBulletSet, type ProjectAgentInputs, type ProjectAgentMeta, type RepoLookupRow, type VerifiedMatch } from './project-agent-inputs.js';
import { EMPTY_OPERATIONS_THEMES_DIAG, type ProjectsAgentDiagnostics } from '../writer/projects-ats-flow.js';
import { logProjectsThemeEvidence, type ProjectsAgentLogKeys } from '../writer/projects-agent-diagnostics.js';

/** Minimal structural logger this module needs -- `.info` (via
 *  `logProjectsThemeEvidence`'s own `EventLogger`) plus `.warn` for the
 *  fail-open gather-failure log line. Pino's `Logger` satisfies this
 *  structurally; tests can inject a plain `{ info: jest.fn(), warn: jest.fn() }`. */
export interface WiringLogger {
    info(obj: object, msg: string): void;
    warn(obj: object, msg: string): void;
}

/** JD strings `activateThemes` matches against: the flattened hard-requirement
 *  skills + preferred skills + concepts (operations-themes.ts's documented
 *  flattening contract -- kept here since `JdSignal` is jd-extractor's type,
 *  not operations-themes.ts's business). */
export function jdStringsForThemes(jd: JdSignal): string[] {
    return [...jd.hardRequirements.map((r) => r.skill), ...jd.preferredSkills, ...jd.concepts];
}

export interface BuildProjectAgentInputsFromMetaArgs {
    readonly bulletSets: readonly ProjectAgentBulletSet[];
    readonly projectMeta: readonly ProjectAgentMeta[];
    readonly repoLookup: ReadonlyMap<string, RepoLookupRow>;
    readonly verifiedMatches: readonly VerifiedMatch[];
    readonly jd: JdSignal;
    readonly pipelineRunId: string;
    readonly applicationId: string;
    readonly log: WiringLogger;
    /** A FACTORY, not a live retrieve function -- so a construction failure
     *  (e.g. `RdsVectorStore.fromEnvironment()` throwing on a missing env
     *  var, the caller's concern, not this module's) surfaces inside this
     *  function's own try/catch, not one scope up in the caller. */
    readonly buildRetrieve: () => (query: string, k: number) => Promise<ReadonlyArray<RetrievedPassage>>;
}

/**
 * Pure-ish core of run-pipeline.ts's `buildProjectAgentInputsWithOperationsEvidence`:
 * every I/O dependency is injected (already-loaded meta; `buildRetrieve`,
 * a factory; `log`), so it is directly unit-testable with a fake retrieve +
 * fixture meta -- proving the wiring order the design depends on:
 * `activateThemes` runs before the gather, and the gather's matches are
 * APPENDED to `verifiedMatches` BEFORE `buildProjectPool` runs, so the SAME
 * fail-closed repo-id attribution governs operations facts as every other
 * verified match. Zero activated themes skips the gather entirely (no
 * retrieval calls, pool identical to a no-themes build -- see (c) in
 * __tests__/operations-wiring.test.ts). A gather-time throw (bad retrieve,
 * bad store construction) is caught here and yields the pool built from
 * `verifiedMatches` alone (fail-open, proven in the same suite).
 */
export async function buildProjectAgentInputsFromMeta(
    args: BuildProjectAgentInputsFromMetaArgs,
): Promise<{ projectAgentInputs: ProjectAgentInputs; themesDiag: ProjectsAgentDiagnostics['themes'] }> {
    const activated = activateThemes(jdStringsForThemes(args.jd));
    if (activated.length === 0) {
        return {
            projectAgentInputs: buildProjectPool(args.bulletSets, args.projectMeta, args.repoLookup, args.verifiedMatches),
            themesDiag: EMPTY_OPERATIONS_THEMES_DIAG,
        };
    }

    const logKeys: ProjectsAgentLogKeys = { pipelineRunId: args.pipelineRunId, applicationId: args.applicationId, traceId: null };

    let opsMatches: VerifiedMatch[] = [];
    let factCounts: Record<string, number> = {};
    try {
        const retrieve = args.buildRetrieve();
        const gathered = await gatherOperationsEvidence({
            themes: activated,
            projects: args.projectMeta,
            retrieve,
        });
        opsMatches = gathered.matches;
        factCounts = gathered.factCounts;
        logProjectsThemeEvidence(args.log, logKeys, opsMatches);
    } catch (err) {
        args.log.warn(
            { pipelineRunId: args.pipelineRunId, err: err instanceof Error ? err.message : String(err) },
            'operations_evidence_failed_open',
        );
    }

    return {
        projectAgentInputs: buildProjectPool(args.bulletSets, args.projectMeta, args.repoLookup, [...args.verifiedMatches, ...opsMatches]),
        themesDiag: { activated: activated.map((t) => t.key), factCounts },
    };
}
