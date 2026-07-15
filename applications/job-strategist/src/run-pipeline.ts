/**
 * @format
 * Strategist analysis K8s Job entrypoint — replaces the
 * Trigger / Research / Strategist / Resume-builder / Analysis-persist Lambda
 * chain orchestrated by Step Functions.
 *
 * Status transitions persisted in platform RDS pipeline_runs:
 *   queued → researching → analysing → persisting → complete (or failed at any step)
 *
 * Parallel job_applications.kanban_status lifecycle:
 *   <prior> → analysing → analysis-ready (or failed)
 *
 * On Strategist success the Strategist-authored tailored StructuredResumeData
 * (Option A) is validated and persisted to platform RDS resumes.
 */
import type { StrategistPipelineContext, StrategistResearchResult, StructuredResumeData, CoverLetter, GroundingMode, JdSignal, BasePipelineContext, PartialMatch, SkillGap, RetrievalPrefilter, StrategistAnalysisResult, AgentResult, SkillEvidenceEntry } from '@bedrock/shared';
import type { Pool } from 'pg';
import { setDefaultAgentInvocationSink, bootstrapK8sObservability, pushFinalMetrics, BedrockGroundingVerifier, BedrockProseLinter, PgSemanticCache, OutputSanitiser, recordInvocationToRds, RoleOntologyRepository, TitanEmbeddingProvider, TechnologyOntologyRepository, SkillOntologyRepository, SkillEmbeddingResolver, PhraseSkillResolver, canonicaliseSkills, RdsVectorStore } from '@bedrock/shared';
import { Counter, Histogram } from 'prom-client';
import { extractResumeProseSections } from './lib/resume/resume-prose.js';

import { executeResearchAgent, KB_CONTEXT_SEPARATOR, sanitiseJobDescription, querySingleRds } from './agents/research/research-agent.js';
import { executeAnalysisAgent } from './agents/analysis/analysis-agent.js';
import type { AnalysisMessageInput } from './agents/analysis/analysis-message.js';
import { executeSkillsAgent } from './agents/writer/skills-agent.js';
import { validateSkillsMembership, deterministicSkills, SkillsValidationError } from './agents/writer/skills-validate.js';
import type { SkillsMessageInput } from './agents/writer/skills-message.js';
import { executeCoverLetterAgent } from './agents/writer/cover-letter-agent.js';
import type { CoverLetterMessageInput } from './agents/writer/cover-letter-message.js';
import { buildSkeletonResume } from './lib/resume/resume-skeleton.js';
import { reconcileResume, type ReconcileInputs } from './lib/resume/resume-reconciler.js';
import { stageSeconds } from './lib/observability/stage-timing.js';
import { framingDirective } from './agents/writer/framing.js';
import { executeSummaryAgent } from './agents/writer/summary-agent.js';
import { deterministicSummary } from './agents/writer/summary-fallback.js';
import { resolveRoleFamilies, stageJdLearning } from './agents/jd/resolve-role-families.js';
import { formatRoleEvidence } from './agents/evidence/role-evidence-block.js';
import { loadProjectEvidenceBlock, loadProjectLaneIndex, loadProjectResumeBullets } from './agents/evidence/project-evidence-block.js';
import { relocateProjectExperience, restoreProjectHighlights } from './agents/quality/relocate-project-experience.js';
import { loadAchievementEvidence } from './agents/evidence/achievement-evidence.js';
import { loadProfileIntelligenceBlock } from './agents/evidence/profile-intelligence-block.js';
import { loadEducation, formatEducation, loadCertifications, formatCertifications, loadCareerHistory, formatExperienceFacts, formatVerifiedYearsFact, type CareerEntry } from './agents/evidence/career-history.js';
import { extractJobDescription, extractJdSignal } from './agents/jd/jd-extractor.js';
import { buildYearsGap } from './agents/writer/years-gap.js';
import { guardCoverLetter } from './agents/quality/cover-letter-guard.js';
import type { CoverLetterNarrativeOpts } from './agents/quality/cover-letter-guard.js';
import { guardResume, revalidateResumeContent, preserveExperienceRoster } from './agents/quality/resume-guard.js';
import type { ResumeGuardCtx, ResumeViolation } from './agents/quality/resume-guard.js';
import { withExperienceLock } from './agents/writer/experience-lock.js';
import type { ViolationLog } from './lib/observability/violation-log.js';
import type { ProjectResumeBulletSet } from './agents/evidence/project-evidence-block.js';
import type { JdPriorityContext } from './ats/length/length-budget.js';
import { annotateGapCauses } from './lib/grounding/gap-cause.js';
import { createViolationLog } from './lib/observability/violation-log.js';
import { loadCandidateContact, formatCandidateContact } from './lib/resume/candidate-contact.js';
import { applyCorrectiveRetrieval, buildBedrockAdjudicator, type CorrectiveStats } from './lib/grounding/corrective-retrieval.js';
import { applyLengthBudget } from './ats/length/length-budget.js';
import { parseKbPassages, attachPassageProvenance } from './ats/grounding/ledger-provenance.js';
import { parseEnv, isFreeMode }   from './env.js';
import { getPool, closePool }     from './lib/db/pg.js';
import { classifyCitedPaths }     from './lib/grounding/path-grounding.js';
import { loadIngestedPaths }      from './lib/grounding/path-grounding-loader.js';
import {
    updatePipelineRun,
    updatePipelineRunMetadata,
    updateJobApplicationStatus,
    persistTailoredResume,
} from './lib/db/pipeline-runs.js';
import { S3Client } from '@aws-sdk/client-s3';
import { renderCheckAndStoreAts } from './ats/gate/run-ats-check.js';
import type { AtsCheckResult } from './ats/gate/ats-check.schema.js';
import { reconcileAtsPassed } from './ats/gate/checks.js';
import { selectSummaryAtsTargets, type SummaryAtsTarget } from './ats/gate/summary-ats-targets.js';
import { resolveSummaryAts, type SummaryAtsDiagnostics } from './agents/writer/summary-ats-flow.js';
import { logSummaryAtsEvents, summaryAtsOutcome } from './agents/writer/summary-ats-diagnostics.js';
import { selectExperienceAtsTargets, type ExperienceAtsTarget } from './ats/gate/experience-ats-targets.js';
import { resolveExperienceAts, type ExperienceAgentDiagnostics } from './agents/writer/experience-ats-flow.js';
import { logExperienceAgentEvents, experienceAgentOutcome } from './agents/writer/experience-agent-diagnostics.js';
import { logProjectsAgentEvents, projectsAgentOutcome } from './agents/writer/projects-agent-diagnostics.js';
import {
    logSectionAgentEvents, skillsAgentOutcome, skillsAgentEvents,
    coverLetterAgentOutcome, coverLetterAgentEvents,
    analysisAgentSummary, analysisAgentEvents,
    type SkillsAgentDiagnostics, type CoverLetterAgentResult,
} from './agents/writer/section-agent-diagnostics.js';
import { executeExperienceAgent } from './agents/writer/experience-agent.js';
import {
    rosterFromCareer, indexCareerLines, assembleExperience, validateExperienceProvenance, ExperienceProvenanceError,
} from './agents/writer/experience-provenance.js';
import { loadProjectAgentInputs, type ProjectAgentInputs } from './agents/evidence/project-agent-inputs.js';
import { executeProjectsAgent } from './agents/writer/projects-agent.js';
import { resolveProjectsAts, deterministicProjects, type ProjectsAgentDiagnostics } from './agents/writer/projects-ats-flow.js';
import { assembleProjects, validateProjectsProvenance, ProjectsProvenanceError } from './agents/writer/projects-provenance.js';
import { namesGap } from './agents/quality/guards/summary-rules.js';
import { buildSkillEvidenceLedger } from './ats/grounding/skill-evidence-ledger.js';
import { canonicalJdSkills } from './ats/context/canonical-jd-skills.js';
import { splitAttainable } from './ats/gate/attainable.js';
import { storeAtsCheckJson } from './ats/gate/store-ats-artifacts.js';
import { demoteMisattributedVendors } from './ats/grounding/vendor-provenance.js';
import { buildCodeStackContext, demoteCodeContradictedMatches } from './ats/grounding/code-truth.js';
import { buildRepoProfiles, buildRepoProfileContext, persistRepoProfiles, type RepoProfile } from './ats/context/repo-profile.js';
import { detectStaleMigrations, reframeStaleMigrations } from './ats/reconcile/migration-reframe.js';
import { buildRetrievalPrefilter } from './ats/context/retrieval-prefilter.js';
import { buildProvenanceRows, persistEvidenceProvenance, buildRepoQualityRows, persistRepoEvidenceQuality } from './lib/grounding/evidence-provenance.js';
import { extractNumbers, stripUngroundedNumbers } from './ats/grounding/number-provenance.js';
import { buildGroundingFacts } from './ats/grounding/grounding-facts.js';
import { loadGroundedMetricsLedger, composeMetricsBlock, resumeHasMetric } from './lib/resume/metrics-ledger.js';
import { reconcileExperienceRoster } from './lib/resume/experience-roster.js';
import { surfaceMetrics } from './agents/quality/surface-metrics.js';
import { surfaceKeywords } from './agents/quality/surface-keywords.js';
import { stripDocumentSections } from './lib/text/strip-document-sections.js';
import { dedupeSkillGaps } from './lib/grounding/dedupe-skill-gaps.js';
import { ensureSummaryIntegrity } from './lib/resume/summary-integrity.js';
import { preserveResumeFields } from './lib/resume/preserve-resume-fields.js';

/**
 * GROUNDED echoes the verifier's (document-stripped) answer back — keep the
 * full original analysis; only a NOT_GROUNDED fallback substitution replaces
 * it. Extracted from main() to keep its complexity at the baseline.
 */
/**
 * Post-chain resume integrity: restore fields a lossy rewrite dropped
 * (projects[].github, observed live) and pass the summary through the
 * lint + bounded-repair gate. Fail-open; never throws; null-safe so the
 * call sites add no branching to main().
 */
async function applyResumeIntegrity(
    resume: StructuredResumeData,
    writerOriginal: StructuredResumeData | null,
    allowed: Set<number>,
    onViolation: (code: string) => void,
): Promise<StructuredResumeData> {
    const restored = preserveResumeFields(writerOriginal, resume);
    try {
        const view = restored as unknown as { summary?: unknown };
        if (typeof view.summary !== 'string' || view.summary.length === 0) return restored;
        const originalSummary = (writerOriginal as unknown as { summary?: unknown } | null)?.summary;
        const gate = await ensureSummaryIntegrity(view.summary, {
            originalSummary: typeof originalSummary === 'string' ? originalSummary : null,
            allowed,
        });
        for (const i of gate.issues) onViolation(i.code);
        if (gate.action !== 'clean') onViolation(`summary_${gate.action}`);
        return { ...restored, summary: gate.summary } as StructuredResumeData;
    } catch {
        return restored;
    }
}

function resolveVerifiedAnalysis(original: string, g: { status: string; answer: string }): string {
    return g.status === 'GROUNDED' ? original : g.answer;
}

/**
 * Summary agent — fills the body's empty summary field. The body writer emits
 * an empty summary; a dedicated Sonnet call (S1-S4 beats, constrained
 * decoding) produces the positioning summary from the research verdicts +
 * finished resume body. On failure (schema/network/etc.) fall back to a
 * deterministic, guard-safe summary derived from the Fit Summary so the
 * pipeline never persists an empty or ungrounded summary. Fail-open by
 * design — never throws into the pipeline. Extracted from main() to keep its
 * complexity at the baseline.
 */
async function fillResumeSummary(
    ctx: StrategistPipelineContext,
    tailoredResumeData: StructuredResumeData | null,
    researchData: StrategistResearchResult,
    profileIntelligence: string,
    yearsGap: YearsGapLite,
    achievementEvidence: string,
    atsTargets: readonly SummaryAtsTarget[],
    metric: Counter<'outcome'>,
    onFallback: (err: unknown) => void,
): Promise<SummaryAtsDiagnostics | null> {
    if (!tailoredResumeData) return null;
    const baseInput = {
        research: researchData,
        body: tailoredResumeData,
        profileIntelligence,
        yearsGapFraming: framingDirective(yearsGap) ?? '',
        achievementEvidence,
    };
    try {
        const first = await executeSummaryAgent(ctx, { ...baseInput, atsTargets: atsTargets.map((t) => t.skill) });
        const { summary, diag } = await resolveSummaryAts({
            firstSummary: first.data.summary,
            targets: atsTargets,
            guard: (s) => (namesGap(s) ? 'namesGap' : null),
            rewrite: async (draft, missing) => {
                const rw = await executeSummaryAgent(
                    ctx,
                    { ...baseInput, atsTargets: missing, rewriteDraft: draft, rewriteMissing: missing },
                    { agentName: 'strategist-summary-rewrite' },
                );
                return rw.data.summary;
            },
        });
        (tailoredResumeData as { summary: string }).summary = summary;
        metric.inc({ outcome: 'agent' });
        return diag;
    } catch (err) {
        (tailoredResumeData as { summary: string }).summary =
            deterministicSummary(researchData.fitSummary, researchData.targetRole);
        metric.inc({ outcome: 'fallback' });
        onFallback(err);
        return {
            targets: [...atsTargets],
            coverageBefore: { targets: atsTargets.length, covered: 0, missing: atsTargets.map((t) => t.skill) },
            rewrite: { fired: false, reason: null, coverageAfter: null, kept: null, keptReason: null },
            fallback: { fired: true, reason: err instanceof Error ? err.message : String(err) },
            guardRejections: [],
        };
    }
}

/**
 * Experience agent -- rewrites the user's indexed career lines into a
 * JD-tailored Experience section. The writer body now emits a roster
 * skeleton only (company/title/period, highlights: []); this dedicated
 * Sonnet call authors the bullets, provenance-guarded against the real
 * career-history lines (see experience-provenance.ts -- every bullet cites
 * its own role's line ids; every line is cited or dropped with a reason).
 * On failure (schema/network/provenance) fall back to the verbatim
 * career-history bullets (first 5 per role) so the pipeline never persists
 * an empty experience section. Fail-open by design -- never throws into the
 * pipeline. Extracted from main() to keep its complexity at the baseline,
 * same shape as fillResumeSummary.
 */
/**
 * Verbatim experience fallback -- company/title/period/first-5-highlights
 * straight from career history, no LLM. Shared by fillResumeExperience's own
 * failure path AND reconcileResume's `fallbacks.experience` closure (the
 * refuse-empty safety net if the agent-owned experience section is STILL
 * empty after fillResumeExperience has already run its own fallback -- see
 * resume-reconciler.ts).
 */
function verbatimExperienceFallback(careerEntries: readonly CareerEntry[]): StructuredResumeData['experience'] {
    return careerEntries.map((e) => ({
        company: e.company, title: e.title, period: e.period, highlights: e.highlights.slice(0, 5),
    }));
}

async function fillResumeExperience(
    ctx: StrategistPipelineContext,
    tailoredResumeData: StructuredResumeData | null,
    researchData: StrategistResearchResult,
    careerEntries: readonly CareerEntry[],
    atsTargets: readonly ExperienceAtsTarget[],
    groundedMetrics: string,
    codeStack: string,
    onFallback: (err: unknown) => void,
): Promise<ExperienceAgentDiagnostics | null> {
    if (!tailoredResumeData) return null;
    if (careerEntries.length === 0) {
        // no career facts: an experience entry without bullets can only be a fabricated roster row -- drop it
        (tailoredResumeData as { experience: unknown }).experience =
            tailoredResumeData.experience.filter((e) => e.highlights.length > 0);
        return null;
    }
    const roster = rosterFromCareer(careerEntries);
    const careerLines = indexCareerLines(careerEntries);
    const baseInput = { research: researchData, roster, careerLines, atsTargets, groundedMetrics, codeStack };
    const verbatim = () => verbatimExperienceFallback(careerEntries);
    try {
        const first = await executeExperienceAgent(ctx, baseInput);
        const firstViolations = validateExperienceProvenance(first.data, roster, careerLines);
        if (firstViolations.length > 0) throw new ExperienceProvenanceError(firstViolations);
        const { output, diag } = await resolveExperienceAts({
            first: first.data, roster, careerLines, targets: atsTargets,
            rewrite: async (draftText, missing) => {
                const rw = await executeExperienceAgent(
                    ctx,
                    { ...baseInput, rewriteDraft: draftText, rewriteMissing: missing },
                    { agentName: 'strategist-experience-rewrite' },
                );
                return rw.data;
            },
        });
        (tailoredResumeData as { experience: unknown }).experience = assembleExperience(output);
        return diag;
    } catch (err) {
        (tailoredResumeData as { experience: unknown }).experience = verbatim();
        onFallback(err);
        return {
            targets: [...atsTargets],
            coverageBefore: { targets: atsTargets.length, covered: 0, missing: atsTargets.map((t) => t.skill) },
            rewrite: { fired: false, reason: null, coverageAfter: null, kept: null, keptReason: null },
            fallback: { fired: true, reason: err instanceof Error ? err.message : String(err) },
            provenance: {
                firstViolations: err instanceof ExperienceProvenanceError ? err.violations : [],
                rewriteViolations: [],
                droppedLines: 0,
                dropped: [],
            },
        };
    }
}

/**
 * Projects agent -- composes the candidate's documented projects into a
 * JD-tailored Projects section. The writer body now emits an empty
 * "projects": [] skeleton only; this dedicated Sonnet call authors the
 * entries, provenance-guarded against the two-lane pool (see
 * projects-provenance.ts -- every curated id and composed source must
 * resolve to its OWN project's pool). On failure (schema/network/
 * provenance) fall back to a deterministic, curated-bullets-only ranking
 * so the pipeline never persists a fabricated project entry. Fail-open by
 * design -- never throws into the pipeline. Same shape as
 * fillResumeExperience.
 *
 * Empty pool (no documented projects, or none with a curated bullet) is
 * left as the writer's own "projects": [] -- there is nothing safe for
 * either the agent or the deterministic fallback to say.
 *
 * No metric param (unlike fillResumeSummary) -- the outcome+reason Counter,
 * coverage Histogram, and Loki event stream are all derived from the
 * returned diagnostics by the caller (recordProjectsAgentObservability),
 * same shape as fillResumeExperience.
 */
async function fillResumeProjects(
    ctx: StrategistPipelineContext,
    tailoredResumeData: StructuredResumeData | null,
    projectAgentInputs: ProjectAgentInputs,
    atsTargets: readonly ExperienceAtsTarget[],
    targetRole: string,
    onFallback: (err: unknown) => void,
): Promise<ProjectsAgentDiagnostics | null> {
    if (!tailoredResumeData) return null;
    const { pool, unresolvedRepos } = projectAgentInputs;
    if (pool.every((p) => p.curated.length === 0)) return null;

    const baseInput = { pool, atsTargets, targetRole };
    try {
        const first = await executeProjectsAgent(ctx, baseInput);
        const firstViolations = validateProjectsProvenance(first.data, pool);
        if (firstViolations.length > 0) throw new ProjectsProvenanceError(firstViolations);
        const { output, diag } = await resolveProjectsAts({
            first: first.data, pool, targets: atsTargets,
            rewrite: async (draftText, missing) => {
                const rw = await executeProjectsAgent(
                    ctx,
                    { ...baseInput, rewriteDraft: draftText, rewriteMissing: missing },
                    { agentName: 'strategist-projects-rewrite' },
                );
                return rw.data;
            },
        });
        (tailoredResumeData as { projects: unknown }).projects = assembleProjects(output, pool);
        return { ...diag, unresolvedRepos };
    } catch (err) {
        (tailoredResumeData as { projects: unknown }).projects = deterministicProjects(pool, atsTargets);
        onFallback(err);
        return {
            targets: [...atsTargets],
            coverageBefore: { targets: atsTargets.length, covered: 0, missing: atsTargets.map((t) => t.skill) },
            rewrite: { fired: false, reason: null, coverageAfter: null, kept: null, keptReason: null },
            fallback: { fired: true, reason: err instanceof Error ? err.message : String(err) },
            provenance: {
                firstViolations: err instanceof ProjectsProvenanceError ? err.violations : [],
                rewriteViolations: [],
                composedCount: 0,
            },
            unresolvedRepos,
        };
    }
}

/** Total skill count across every category -- diagnostics field only. */
function skillItemCount(categories: readonly { skills: readonly string[] }[]): number {
    return categories.reduce((n, c) => n + c.skills.length, 0);
}

/**
 * Skills agent -- fills the skeleton's empty skills[] field. Mirrors
 * fillResumeExperience/fillResumeProjects: executeSkillsAgent ->
 * validateSkillsMembership (ledger-membership contract, see
 * skills-validate.ts) -> a violation throws SkillsValidationError -> catch
 * -> deterministicSkills (ledger-only, no model call) fallback. Fail-open by
 * design -- never throws into the pipeline.
 *
 * Diagnostics use the shared SkillsAgentDiagnostics shape (see
 * section-agent-diagnostics.ts) -- the outcome+reason Counter and the Loki
 * event stream are both derived from the returned diagnostics by the caller
 * (recordSkillsAgentObservability), same shape as fillResumeExperience /
 * fillResumeProjects. No metric param here (unlike the pre-T9 shape) -- see
 * that helper's doc comment.
 */
async function fillResumeSkills(
    ctx: StrategistPipelineContext,
    tailoredResumeData: StructuredResumeData | null,
    input: SkillsMessageInput,
    ledger: readonly SkillEvidenceEntry[],
    jd: JdSignal,
    onFallback: (err: unknown) => void,
): Promise<SkillsAgentDiagnostics | null> {
    if (!tailoredResumeData) return null;
    try {
        const first = await executeSkillsAgent(ctx, input);
        const violations = validateSkillsMembership(first.data, ledger);
        if (violations.length > 0) throw new SkillsValidationError(violations);
        (tailoredResumeData as { skills: unknown }).skills = first.data.skills;
        return { outcome: 'agent', violations: [], categories: first.data.skills.length, items: skillItemCount(first.data.skills) };
    } catch (err) {
        const fallback = deterministicSkills(ledger, jd);
        (tailoredResumeData as { skills: unknown }).skills = fallback;
        onFallback(err);
        return {
            outcome: 'fallback',
            violations: err instanceof SkillsValidationError ? err.violations : [],
            categories: fallback.length,
            items: skillItemCount(fallback),
        };
    }
}

/**
 * Projects-agent observability: Loki event stream + bounded Prometheus
 * outcome/coverage metrics + the repo-unresolved counter, all derived from
 * fillResumeProjects's returned diagnostics. Extracted to a helper (rather
 * than the inline `if (diag) {...}` block used for experienceAgentDiag /
 * summaryAtsDiag above) so main() doesn't gain new branch points -- main()
 * is already flagged over the complexity threshold; a plain function call
 * here adds none. Guards the null-diag case (no pool / no writer target)
 * internally.
 */
function recordProjectsAgentObservability(
    diag: ProjectsAgentDiagnostics | null,
    keys: { pipelineRunId: string; applicationId: string | null },
): void {
    if (!diag) return;
    logProjectsAgentEvents(log, { pipelineRunId: keys.pipelineRunId, applicationId: keys.applicationId, traceId: null }, diag);
    const { outcome, reason } = projectsAgentOutcome(diag);
    projectsOutcomeMetric.inc({ outcome, reason });
    if (diag.targets.length > 0 && !diag.fallback.fired) {
        projectsAgentCoverageMetric.observe(diag.coverageBefore.covered);
    }
    if (diag.unresolvedRepos.length > 0) {
        projectsRepoUnresolvedMetric.inc(diag.unresolvedRepos.length);
    }
}
import { formatTechTransferContext } from './ats/context/tech-transfer-context.js';
import { attachCodeEvidence } from './ats/grounding/tool-evidence-retrieval.js';
import { attachSourceLanes, mergeRepoLane } from './ats/grounding/evidence-lane.js';
import { applyDegreeReconcile } from './ats/reconcile/education-reconcile.js';
import { applyYearsGapReconcile } from './ats/reconcile/years-gap-reconcile.js';
import { runFreeTier }             from './free/run-free.js';
import { gatherFreeEvidence }      from './free/gather-evidence.js';
import { bedrockFreeResumeWriter } from './agents/writer/free-resume-writer.js';

// Default 'flag' — serve the real analysis and surface ungrounded claims via
// telemetry, rather than 'block' replacing a cited analysis with a one-line stub.
// Set GROUNDING_MODE=block to restore strict replacement for a stricter tier.
const groundingVerifier = new BedrockGroundingVerifier({
    mode: (process.env['GROUNDING_MODE'] as GroundingMode) ?? 'flag',
});

/** Shared Postgres+pgvector semantic response cache (fail-open). */
const semanticCache = PgSemanticCache.fromEnvironment();
/** Redacts infra identifiers from the failure message before it reaches the client. */
const outputSanitiser = new OutputSanitiser();

/**
 * Query-side phrase -> canonical resolver — the read-only twin of the ingestion
 * enricher's resolver. No self-heal backfill (ingestion owns embedding the
 * ontology); this just embeds a JD skill phrase and maps it to its nearest
 * canonical so the query side of `d.skills && query.skills` resolves like the
 * corpus side. Same SKILL_MATCH_THRESHOLD as the corpus side for symmetry.
 */
function buildQuerySkillResolver(pool: Pool): (phrase: string) => Promise<string | null> {
    const threshold = process.env['SKILL_MATCH_THRESHOLD']
        ? Number.parseFloat(process.env['SKILL_MATCH_THRESHOLD'])
        : undefined;
    const resolver = new SkillEmbeddingResolver(pool, threshold);
    const phraseResolver = new PhraseSkillResolver(TitanEmbeddingProvider.fromEnvironment(), resolver);
    return (phrase) => phraseResolver.resolve(phrase);
}

/**
 * Build the filter-then-rank retrieval prefilter, canonicalising the JD's
 * skills through the SAME cascade the corpus side uses (alias -> embedding
 * nearest-canonical -> raw) so BOTH sides of `d.skills && query.skills` resolve
 * to identical canonicals — without this the overlap silently misses any phrase
 * the corpus collapsed by embedding. Env-gated (RETRIEVAL_PREFILTER=on); absent
 * => today's pure-vector retrieval. Read-only + fail-open. Extracted from main()
 * to keep its complexity bounded.
 */
async function buildQueryRetrievalPrefilter(
    pool: Pool,
    jdExtraction: JdSignal,
    techGroups: ReadonlyArray<ReadonlyArray<string>>,
    aliasToCanonical: ReadonlyMap<string, string>,
): Promise<ReturnType<typeof buildRetrievalPrefilter> | undefined> {
    if (process.env['RETRIEVAL_PREFILTER'] !== 'on') return undefined;
    const ti = jdExtraction.technologyInventory;
    const querySkills = await canonicaliseSkills(
        [...jdExtraction.requiredSkills, ...jdExtraction.preferredSkills],
        await new SkillOntologyRepository(pool).loadAliasToCanonicalMap().catch(() => new Map<string, string>()),
        buildQuerySkillResolver(pool),
    );
    return buildRetrievalPrefilter(
        querySkills,
        [...ti.tools, ...ti.languages, ...ti.frameworks, ...ti.infrastructure, ...jdExtraction.retrievalKeywords],
        techGroups, aliasToCanonical,
    );
}

/**
 * Cover-letter narrative context: the JD's values rubric, the documented
 * project pitches, and the resume's numbers (overlap = the letter restating
 * the resume). Extracted from main() to keep its complexity bounded.
 */
type YearsGapLite = { framingLine: string; requiredYears: number | null } | null;

/** True when the JD sets an explicit years-of-experience requirement. */
function jdHasYearsBar(yearsGap: YearsGapLite): boolean {
    return yearsGap?.requiredYears != null;
}

/** The tenure framing the LETTER may use — empty when the JD sets no years bar. */
function tenureFramingFor(yearsGap: YearsGapLite): string {
    if (!jdHasYearsBar(yearsGap) || !yearsGap) return '';
    return yearsGap.framingLine;
}

/**
 * Anchor the writer's experience roster to career-history truth (merge
 * duplicated roles, restore company names). Null-safe; reports each fix.
 * Extracted from main() to keep its complexity bounded.
 */
function reconcileRosterAgainstCareer(
    resume: StructuredResumeData | null,
    career: Parameters<typeof reconcileExperienceRoster>[1],
    onViolation: (code: string) => void,
): StructuredResumeData | null {
    if (!resume) return null;
    const { resume: fixed, violations } = reconcileExperienceRoster(resume, career);
    for (const v of violations) onViolation(v);
    return fixed;
}

/**
 * Snapshot a resume's Experience section for the net-fired safety-net
 * counter -- a downstream pass (guard/length/surface-keywords) that changes
 * this snapshot touched the agent-owned, provenance-guarded Experience
 * section it should be leaving alone. Null-safe (both a null resume and a
 * resume with no experience snapshot to the same stable string).
 */
function expSnapshot(resume: StructuredResumeData | null): string {
    return JSON.stringify(resume?.experience ?? null);
}

/**
 * Snapshot a resume's Projects section for the net-fired safety-net counter --
 * the projects twin of expSnapshot above, agent-owned once fillResumeProjects
 * has run.
 */
function projSnapshot(resume: StructuredResumeData | null): string {
    return JSON.stringify(resume?.projects ?? null);
}

/**
 * Record a net-fired instrumentation hit when a downstream pass changed an
 * agent-owned section snapshot. Shared by the 4 call sites (guard, length x2,
 * surface_keywords) so main() doesn't repeat the inline `if` branch (and
 * doesn't grow main()'s already-flagged complexity by inlining a second
 * comparison at each site). Emits the generalised
 * job_strategist_section_net_fired_total{section,pass,outcome="changed"} for
 * BOTH agent-owned sections -- see sectionNetFiredMetric's comment above.
 * PR-B removed the older, experience-only
 * job_strategist_experience_net_fired_total{pass} counter this generalised
 * one superseded. Every call site is now wrapped in withExperienceLock
 * (experience-lock.ts) BEFORE it reaches this function, so `beforeExp` and
 * `afterExp` are always equal in practice -- the lock enforces immutability
 * rather than merely detecting drift, and its own onRestored callback emits
 * the sibling outcome="restored" series. `projects` has no lock (Phase 5
 * PR-A/B did not extend one), so `outcome="changed"` remains a live signal
 * there.
 */
function trackNetFired(
    pass: 'guard' | 'length' | 'surface_keywords',
    beforeExp: string, afterExp: string,
    beforeProj: string, afterProj: string,
): void {
    if (beforeExp !== afterExp) {
        sectionNetFiredMetric.inc({ section: 'experience', pass, outcome: 'changed' });
    }
    if (beforeProj !== afterProj) {
        sectionNetFiredMetric.inc({ section: 'projects', pass, outcome: 'changed' });
    }
}

/**
 * Grounded-metric weave: ONE bounded surface-metrics rewrite on EVERY resume
 * when the ledger is non-empty (roster-preserving), then re-strip ungrounded
 * numbers — ledger values are in `allowed`, so only drifted values are
 * removed. Reports when the weave leaves the resume metric-free. Fail-open.
 * Extracted from main() to keep its complexity bounded.
 */
async function weaveGroundedMetrics(
    resume: StructuredResumeData,
    groundedMetricsBlock: string,
    groundingFacts: string,
    allowed: Set<number>,
    jdContext: string,
    onEvent: (code: string) => void,
): Promise<StructuredResumeData> {
    if (!groundedMetricsBlock) return resume;
    const surfaced = preserveExperienceRoster(resume, await surfaceMetrics(resume, groundedMetricsBlock, { groundingFacts, jdContext }).catch(() => resume));
    const woven = stripUngroundedNumbers(surfaced, allowed);
    if (!resumeHasMetric(woven)) onEvent('resume_missing_metrics_after_weave');
    return woven;
}

function buildCoverLetterNarrative(
    jdExtraction: JdSignal,
    projectPitches: ReadonlyArray<{ name: string; pitch: string }>,
    tailoredResumeData: unknown,
    hasYearsBar: boolean,
): CoverLetterNarrativeOpts {
    const valuesSignals = [
        ...(jdExtraction.implicitRequirements ?? []),
        ...(jdExtraction.softRequirements ?? []).map((sr) => sr.skill),
    ];
    const resumeNumbers = new Set(
        (JSON.stringify(tailoredResumeData ?? {}).match(/\d+(?:[.,]\d+)?\+?/g) ?? []).map((n) => n.replace(/[,+]/g, '')),
    );
    return { hasYearsBar, valuesSignals, projectPitches, companyProblem: jdExtraction.companyProblem, resumeNumbers };
}

/** Verified certification facts for the guard (name + date string). */
/** Reconcile outcome label without a nested ternary. */
function degreeOutcome(r: { verified?: unknown; partial?: unknown }): string {
    if (r.verified) return 'verified';
    if (r.partial) return 'partial';
    return 'gap';
}

/** Career-history employers + their verified highlight facts — the guard's attribution boundary. */
function toVerifiedEmployers(entries: ReadonlyArray<{ company: string; highlights?: readonly string[] }> | undefined): Array<{ name: string; facts: string }> {
    return (entries ?? []).map((c) => ({ name: c.company, facts: (c.highlights ?? []).join(' ') }));
}

function toVerifiedCerts(entries: ReadonlyArray<{ name: string; date: string }> | undefined): Array<{ name: string; date: string }> {
    return (entries ?? []).map((c) => ({ name: c.name, date: c.date }));
}

/**
 * Corrective retrieval (CRAG-style, fail-open; CORRECTIVE_RETRIEVAL=off is the
 * kill switch). Live measurement: 76% of classified gaps (100/131) were
 * kb_present_not_retrieved — evidence exists in the KB but the JD-wide research
 * queries missed it. Re-query per gap with a skill-focused query and let a
 * strict Haiku adjudicator promote genuine evidence to a partialMatch (default
 * verdict: stand — the tsv classifier overcounts lexical mentions). Runs AFTER
 * the deterministic guards so demotions are respected, BEFORE the
 * ledger/strategist consume gaps. Extracted from main() to keep its complexity
 * bounded (same pattern as buildQueryRetrievalPrefilter).
 */
async function runCorrectiveRetrievalPass<T extends { gaps: SkillGap[]; partialMatches: PartialMatch[] }>(args: {
    matching: T;
    pool: Pool;
    userId: string;
    pipelineRunId: string;
    pipelineContext: BasePipelineContext;
    retrievalPrefilter: RetrievalPrefilter | undefined;
}): Promise<{ matching: T; stats: CorrectiveStats | null }> {
    if (process.env['CORRECTIVE_RETRIEVAL'] === 'off') return { matching: args.matching, stats: null };
    try {
        const correctiveStore = RdsVectorStore.fromEnvironment();
        const corrective = await applyCorrectiveRetrieval(args.matching, {
            pool: args.pool,
            userId: args.userId,
            retrieve: (q, k) => querySingleRds(q, args.userId, correctiveStore, k, args.retrievalPrefilter),
            adjudicate: buildBedrockAdjudicator({ pipelineContext: args.pipelineContext, userId: args.userId }),
        });
        if (corrective.stats.promoted > 0) correctiveRetrievalMetric.inc({ outcome: 'promoted' }, corrective.stats.promoted);
        const stood = corrective.stats.retrieved - corrective.stats.promoted;
        if (stood > 0) correctiveRetrievalMetric.inc({ outcome: 'stood' }, stood);
        if (corrective.stats.candidates > 0) {
            log.info({ pipelineRunId: args.pipelineRunId, ...corrective.stats }, 'corrective_retrieval_pass');
        }
        return { matching: corrective.matching, stats: corrective.stats };
    } catch (err) {
        log.warn({ pipelineRunId: args.pipelineRunId, err: String(err) }, 'corrective_retrieval_failed_open');
        return { matching: args.matching, stats: null };
    }
}

/** S3 client for canonical resume PDF storage. */
const s3 = new S3Client({});

// Shared registry across both run-pipeline (analyse) and run-coach so
// dashboard rollups can be done service-wide.
const obs = bootstrapK8sObservability({ serviceName: 'job-strategist' });
const log = obs.logger;

const strategistRuns = new Counter({
    name:       'job_strategist_runs_total',
    help:       'Strategist Job runs by operation and outcome.',
    labelNames: ['operation', 'outcome'] as const,
    registers:  [obs.registry],
});
const strategistDuration = new Histogram({
    name:       'job_strategist_duration_seconds',
    help:       'End-to-end Strategist Job duration in seconds.',
    labelNames: ['operation', 'outcome'] as const,
    buckets:    [10, 30, 60, 120, 300, 600, 1200, 1800],
    registers:  [obs.registry],
});
/**
 * Per-stage wall-clock breakdown of strategistDuration above -- the headline
 * observability this task ships: the pre-split writer call alone cost ~6min
 * of the end-to-end duration and that cost is now invisible unless it is
 * broken out by stage. Stages: research, batch1 (analysis + experience +
 * projects + skills, concurrent), reconcile, batch2 (summary + cover letter,
 * concurrent), guards, length, ats_gate, persist. See lib/stage-timing.ts
 * for the pure timing helper (stageSeconds) this histogram is fed through.
 */
const pipelineStageSeconds = new Histogram({
    name:       'job_strategist_pipeline_stage_seconds',
    help:       'Wall-clock duration of each Strategist pipeline stage, in seconds.',
    labelNames: ['stage'] as const,
    buckets:    [1, 5, 15, 30, 60, 120, 240, 480],
    registers:  [obs.registry],
});
/** Count of file-path citations in the analysis that are NOT in the user's
 *  ingested document_embeddings — i.e. hallucinated/inferred source paths. */
const ungroundedPaths = new Counter({
    name:       'job_strategist_ungrounded_paths_total',
    help:       'File-path citations in the analysis not found in ingested document_embeddings.',
    labelNames: ['operation'] as const,
    registers:  [obs.registry],
});

// Resume prose-quality verdicts (stop-slop). status ∈ PASS|FAIL|error|skipped.
const resumeProse = new Counter({
    name:       'job_strategist_resume_prose_total',
    help:       'Strategist resume/cover prose-quality verdicts by status.',
    labelNames: ['status'] as const,
    registers:  [obs.registry],
});
const coverLetterViolations = new Counter({
    name:      'job_strategist_cover_letter_violations_total',
    help:      'Cover-letter guard violations caught (and rewritten) by code.',
    labelNames: ['code'] as const,
    registers:  [obs.registry],
});
const resumeViolationsMetric = new Counter({
    name:       'job_strategist_resume_violations_total',
    help:       'Resume guard violations caught (and rewritten) by code.',
    labelNames: ['code'] as const,
    registers:  [obs.registry],
});
const atsFeedback = new Counter({
    name:       'job_strategist_ats_feedback_total',
    // 'passed' is the RECONCILED headline outcome (reconcileAtsPassed: status
    // === 'passed' AND attainablePassed !== false) — the single truth a
    // downstream consumer should read instead of comparing this against the
    // per-render `ats_${status}` outcome on job_strategist_runs_total, which
    // can legitimately disagree with the attainable-only signal (F5).
    help:       'ATS feedback loop outcomes: fired (re-write ran), passed (reconciled headline pass-mark), skipped (re-write not run).',
    labelNames: ['outcome'] as const,
    registers:  [obs.registry],
});
const gapCauseMetric = new Counter({
    name:       'job_strategist_gap_cause_total',
    help:       'Research gap causes: kb_present_not_retrieved (retrieval tuning lead) vs kb_no_evidence (document-or-build signal).',
    labelNames: ['cause'] as const,
    registers:  [obs.registry],
});
const summaryOutcomeMetric = new Counter({
    name:       'job_strategist_summary_agent_outcome_total',
    help:       'Summary agent outcomes: agent (dedicated summary agent filled the resume summary) vs fallback (agent call failed, deterministic summary used).',
    labelNames: ['outcome'] as const,
    registers:  [obs.registry],
});
// {outcome, reason} shape (Task 9) -- outcome in {agent, fallback}, reason in
// {ok, membership-invalid, agent-error, caps} (see skillsAgentOutcome).
const skillsOutcomeMetric = new Counter({
    name:       'job_strategist_skills_agent_outcome_total',
    help:       'Skills agent outcomes: agent (dedicated skills agent filled the resume skills) vs fallback (agent call failed or violated ledger membership, deterministic skills used), by reason.',
    labelNames: ['outcome', 'reason'] as const,
    registers:  [obs.registry],
});
const experienceOutcomeMetric = new Counter({
    name:       'job_strategist_experience_agent_outcome_total',
    help:       'Experience-agent lane outcome by result and reason.',
    labelNames: ['outcome', 'reason'] as const,
    registers:  [obs.registry],
});
const projectsOutcomeMetric = new Counter({
    name:       'job_strategist_projects_agent_outcome_total',
    help:       'Projects-agent lane outcome by result and reason.',
    labelNames: ['outcome', 'reason'] as const,
    registers:  [obs.registry],
});
// Task 9 -- outcome in {agent, omitted}, reason in {ok, agent-error, not-requested}
// (see coverLetterAgentOutcome). 'omitted' covers both "not requested"
// (ctx.includeCoverLetter === false) and "requested but the agent call
// failed" -- guardCoverLetter's rewrite pass never nulls a non-null letter,
// so no third outcome is possible here.
const coverLetterOutcomeMetric = new Counter({
    name:       'job_strategist_cover_letter_agent_outcome_total',
    help:       'Cover-letter agent outcomes: agent (letter generated) vs omitted (not requested, or the agent call failed), by reason.',
    labelNames: ['outcome', 'reason'] as const,
    registers:  [obs.registry],
});
const projectsAgentCoverageMetric = new Histogram({
    name:       'job_strategist_projects_agent_coverage',
    help:       'Covered ATS targets in the projects section (0..N).',
    buckets:    [0, 1, 2, 3, 4, 5, 6],
    registers:  [obs.registry],
});
/** Count of repo-citation names that failed fail-closed attribution to a
 *  known project during projects-agent pool construction (see
 *  ProjectAgentInputs.unresolvedRepos in project-agent-inputs.ts). Unlabelled
 *  -- the name list itself goes to the Loki projects_repo_unresolved event
 *  only, never a metric label (unbounded cardinality). */
const projectsRepoUnresolvedMetric = new Counter({
    name:      'job_strategist_projects_repo_unresolved_total',
    help:      'Repo-citation names that failed fail-closed attribution to a known project during projects-agent pool construction.',
    registers: [obs.registry],
});
const experienceAgentCoverageMetric = new Histogram({
    name:       'job_strategist_experience_agent_coverage',
    help:       'Covered ATS targets in the experience section (0..N).',
    buckets:    [0, 1, 2, 3, 4, 5, 6],
    registers:  [obs.registry],
});
// Safety-net signal: experience/projects are agent-owned once their fill
// passes have run (provenance-guarded bullets), so a downstream
// guard/length/keyword-surface pass changing either is unexpected.
// preserveExperienceRoster only guarantees no ROLE is dropped -- it does not
// stop a pass rewriting a bullet within a role that survives -- so this
// counter is the only signal for that narrower drift. Generalises the older,
// experience-only job_strategist_experience_net_fired_total{pass} counter
// (removed PR-B) to cover BOTH agent-owned sections behind one metric name
// (section='experience' here is that counter's exact equivalent).
// `outcome` (added alongside withExperienceLock, experience-lock.ts):
// 'changed' is the ORIGINAL tripwire increment -- a pass's output diverged
// from the pre-pass snapshot. 'restored' fires only for section='experience'
// (the only section wrapped in the lock so far) when withExperienceLock
// reverted that divergence, turning the tripwire into enforcement --
// section='experience' should now show 'changed' at effectively zero (every
// divergence is caught and restored before it reaches the next stage) while
// 'restored' becomes the signal to watch. section='projects' has no lock, so
// it only ever emits 'changed'.
const sectionNetFiredMetric = new Counter({
    name:       'job_strategist_section_net_fired_total',
    help:       'Downstream passes (guard/length/surface_keywords/reframe/metric_weave/revalidate) that changed an agent-owned section (experience/projects) after its fill pass ran, by outcome (changed vs restored by the experience lock).',
    labelNames: ['section', 'pass', 'outcome'] as const,
    registers:  [obs.registry],
});
const correctiveRetrievalMetric = new Counter({
    name:       'job_strategist_corrective_retrieval_total',
    help:       'Corrective-retrieval verdicts on kb_present_not_retrieved gaps: promoted (evidence recovered) vs stood (lexical mention only).',
    labelNames: ['outcome'] as const,
    registers:  [obs.registry],
});
const summaryAtsOutcomeMetric = new Counter({
    name:       'job_strategist_summary_ats_outcome_total',
    help:       'Summary-ATS lane outcome by result and reason.',
    labelNames: ['outcome', 'reason'] as const,
    registers:  [obs.registry],
});
const summaryAtsCoverageMetric = new Histogram({
    name:       'job_strategist_summary_ats_coverage',
    help:       'Covered ATS targets in the summary (0..N).',
    buckets:    [0, 1, 2, 3],
    registers:  [obs.registry],
});
// Prose linting runs in 'flag' mode only — telemetry on AI-tell language in the
// generated resume + cover letter; never alters or blocks the persisted output.
const resumeProseLinter = new BedrockProseLinter({ mode: 'flag' });

/**
 * Lint the Strategist's resume + cover-letter prose for AI-tell language and
 * record the verdict (metric + log). Flag-mode + fail-open: pure observability —
 * never alters persisted output and never throws into the pipeline.
 */
async function lintResumeProse(
    pool: Pool,
    env: ReturnType<typeof parseEnv>,
    resume: StructuredResumeData | null,
    coverLetter: CoverLetter | null,
): Promise<void> {
    try {
        const sections = extractResumeProseSections(resume, coverLetter);
        if (sections.length === 0) {
            resumeProse.inc({ status: 'skipped' });
            return;
        }
        const q = await resumeProseLinter.lint(
            { sections, stage: 'applied' },
            { pool, userId: env.userId },
        );
        resumeProse.inc({ status: q.status });
        if (q.status === 'FAIL') {
            log.warn({
                pipelineRunId: env.pipelineRunId,
                applicationId: env.applicationId,
                proseScore:    q.score,
                proseIssues:   q.issues,
            }, 'resume_prose_below_threshold');
        }
    } catch (e) {
        resumeProse.inc({ status: 'error' });
        log.warn({
            pipelineRunId: env.pipelineRunId,
            err:           (e as Error).message,
        }, 'resume_prose_lint_failed (non-fatal)');
    }
}

/**
 * Record the run's evidence provenance (Phase 1) + per-repo quality rollup (Phase 2)
 * into their queryable tables. Flattens the retrieval trace + usage attribution
 * (cited / demoted / never-used) already computed upstream. Pure observability
 * side-channel — fail-open, never gates the run.
 */
interface RunProvenanceInputs {
    readonly pool: Pool;
    readonly env: { pipelineRunId: string; userId: string };
    readonly researchData: StrategistResearchResult;
    readonly matching: { verifiedMatches: ReadonlyArray<{ evidenceFiles?: string[] }>; partialMatches: ReadonlyArray<{ evidenceFiles?: string[] }> };
    readonly demotions: ReadonlyArray<{ evidenceFiles: string[] }>;
    readonly contradictions: ReadonlyArray<{ evidenceFiles: string[] }>;
    readonly codeTechByRepo: ReadonlyMap<string, ReadonlySet<string>>;
    readonly repoProfiles: ReadonlyArray<RepoProfile>;
}

async function recordRunProvenance(args: RunProvenanceInputs): Promise<void> {
    const { pool, env, researchData, matching, demotions, contradictions, codeTechByRepo, repoProfiles } = args;
    try {
        const verifiedFiles = new Set<string>();
        for (const m of matching.verifiedMatches) for (const f of m.evidenceFiles ?? []) verifiedFiles.add(f);
        const partialFiles = new Set<string>();
        for (const m of matching.partialMatches) for (const f of m.evidenceFiles ?? []) partialFiles.add(f);
        const demotedFiles = new Map<string, 'vendor_provenance' | 'code_truth'>();
        for (const d of demotions) for (const f of d.evidenceFiles) demotedFiles.set(f, 'vendor_provenance');
        for (const c of contradictions) for (const f of c.evidenceFiles) demotedFiles.set(f, 'code_truth');
        const provRows = buildProvenanceRows({
            kbContext: researchData.kbContext ?? '',
            floor: researchData.kbRetrievalStats?.floor ?? 0.2,
            verifiedFiles, partialFiles, demotedFiles,
        });
        const meta = { pipelineRunId: env.pipelineRunId, userId: env.userId };
        const persisted = await persistEvidenceProvenance(pool, {
            ...meta, targetRole: researchData.targetRole, targetCompany: researchData.targetCompany ?? '', agent: 'research',
        }, provRows);
        const qualityRows = buildRepoQualityRows(provRows, codeTechByRepo);
        await persistRepoEvidenceQuality(pool, { ...meta, targetRole: researchData.targetRole }, qualityRows);
        const profilesPersisted = await persistRepoProfiles(pool, meta, repoProfiles);
        log.info({ pipelineRunId: env.pipelineRunId, provenanceRows: persisted, repoQualityRows: qualityRows.length, repoProfiles: profilesPersisted }, 'evidence_provenance_persisted');
    } catch (e) {
        log.warn({ pipelineRunId: env.pipelineRunId, err: (e as Error).message }, 'evidence_provenance_persist_failed (non-fatal)');
    }
}

/**
 * Build the semantic-cache kb_tag for a user. Fail-open: on any DB error
 * fall back to a model-only tag so the cache still partitions by model.
 */
async function cacheTagFor(pool: Pool, userId: string): Promise<string> {
    const model = process.env['STRATEGIST_MODEL'] ?? 'default';
    try {
        const r = await pool.query<{ t: string }>(
            `SELECT COALESCE(MAX(last_synced_at)::text, '') || COALESCE((MAX(kb_quality_breakdown->>'version')), '') AS t FROM repo_sync_state WHERE user_id = $1`,
            [userId]);
        return `${r.rows[0]?.t ?? ''}:${model}`;
    } catch { return `:${model}`; }
}

/**
 * Verify that file-path citations in the final analysis exist in the user's
 * ingested `document_embeddings`. The text-level grounding verifier confirms
 * claim *content* but not *path existence*, so a real-tech / invented-path
 * citation (e.g. `api/admin-api/src/**` inferred from prose) can slip through.
 *
 * Fail-open: any DB/parse error returns an empty classification so the run
 * never hard-fails on this advisory check. Returns the classification for
 * stashing on pipeline_runs.metadata so admin-api / the UI can surface a
 * "these cited paths were not found in your ingested repos" warning.
 */
async function verifyAnalysisPaths(
    pool: Pool,
    userId: string,
    analysisXml: string,
    pipelineRunId: string,
): Promise<{ grounded: string[]; ungrounded: string[] }> {
    try {
        const ingested = await loadIngestedPaths(pool, userId);
        const { grounded, ungrounded } = classifyCitedPaths(analysisXml, ingested);
        if (ungrounded.length > 0) {
            ungroundedPaths.inc({ operation: 'analyse' }, ungrounded.length);
            log.warn({
                pipelineRunId,
                ungroundedPaths: ungrounded,
                groundedCount:   grounded.length,
            }, 'analysis_cited_ungrounded_paths');
        }
        return { grounded, ungrounded };
    } catch (e) {
        log.warn({
            pipelineRunId,
            error: (e as Error).message,
        }, 'Path-grounding check failed — skipping (fail-open)');
        return { grounded: [], ungrounded: [] };
    }
}

// =============================================================================
// BATCH ORCHESTRATION (Phase 5 PR-B Task 7) -- the deterministic skeleton +
// batch-1 (analysis + experience + projects + skills, concurrent) + reconcile
// + batch-2 (summary + cover letter, concurrent) pipeline that replaces the
// single sequential ~6-minute writer call. Extracted from main() so main()
// gains no new branch points from this rewiring -- each helper below is its
// own function for eslint's `complexity` rule too.
// =============================================================================

interface Batch1Result {
    readonly analysis: AgentResult<StrategistAnalysisResult>;
    readonly experienceAgentDiag: ExperienceAgentDiagnostics | null;
    readonly projectsAgentDiag: ProjectsAgentDiagnostics | null;
    readonly skillsAgentDiag: SkillsAgentDiagnostics | null;
}

/**
 * Batch 1 -- the analysis agent (Phase 0 archetype + Phase 1-3 narrative) and
 * the three section-agent fillers (experience/projects/skills) run
 * CONCURRENTLY against the shared skeleton object built by buildSkeletonResume.
 *
 * Concurrency safety: accumulateContext (agent-runner.ts:232) has no `await`
 * between its `+=` ops on ctx.cumulativeTokens/cumulativeCostUsd, so four
 * agents racing to update the SAME pipeline-context counters never interleave
 * a torn read/write. The three fillers each mutate a DISJOINT top-level field
 * of the one skeleton (experience / projects / skills respectively) -- no
 * data race on the resume object either.
 *
 * executeAnalysisAgent is the ONLY member that can reject: parseAnalysisResponse
 * throws on an empty/blank analysisXml (load-bearing -- the semantic-cache
 * hit gate requires a non-empty string). A rejection here fails the whole
 * batch and propagates to main()'s outer catch, exactly like the pre-split
 * writer's single call failing used to.
 */
async function runBatch1Agents(args: {
    ctx: StrategistPipelineContext;
    skeleton: StructuredResumeData | null;
    analysisInput: AnalysisMessageInput;
    researchData: StrategistResearchResult;
    careerEntries: readonly CareerEntry[];
    experienceAtsTargets: readonly ExperienceAtsTarget[];
    groundedMetricsBlock: string;
    codeStackContext: string;
    projectAgentInputs: ProjectAgentInputs;
    skillsInput: SkillsMessageInput;
    skillEvidenceLedger: readonly SkillEvidenceEntry[];
    jdExtraction: JdSignal;
    pipelineRunId: string;
}): Promise<Batch1Result> {
    const {
        ctx, skeleton, analysisInput, researchData, careerEntries, experienceAtsTargets,
        groundedMetricsBlock, codeStackContext, projectAgentInputs, skillsInput,
        skillEvidenceLedger, jdExtraction, pipelineRunId,
    } = args;
    const [analysis, experienceAgentDiag, projectsAgentDiag, skillsAgentDiag] = await Promise.all([
        executeAnalysisAgent(ctx, analysisInput),
        fillResumeExperience(
            ctx, skeleton, researchData, careerEntries, experienceAtsTargets, groundedMetricsBlock, codeStackContext,
            (err) => log.warn({ pipelineRunId, agent: 'strategist-experience', err: err instanceof Error ? err.message : String(err) }, 'experience_agent_failed_verbatim_fallback_used'),
        ),
        fillResumeProjects(
            ctx, skeleton, projectAgentInputs, experienceAtsTargets, researchData.targetRole,
            (err) => log.warn({ pipelineRunId, agent: 'strategist-projects', err: err instanceof Error ? err.message : String(err) }, 'projects_agent_failed_deterministic_fallback_used'),
        ),
        fillResumeSkills(
            ctx, skeleton, skillsInput, skillEvidenceLedger, jdExtraction,
            (err) => log.warn({ pipelineRunId, agent: 'strategist-skills', err: err instanceof Error ? err.message : String(err) }, 'skills_agent_failed_deterministic_fallback_used'),
        ),
    ]);
    return { analysis, experienceAgentDiag, projectsAgentDiag, skillsAgentDiag };
}

/**
 * Batch-1 observability: Loki event stream + bounded Prometheus outcome/
 * coverage metrics for the experience + projects lanes (mirrors the inline
 * blocks the pre-split pipeline had after each sequential fill call).
 * skillsAgentDiag has no event stream yet (see fillResumeSkills's doc
 * comment) -- its Counter is incremented inside fillResumeSkills itself.
 */
function recordBatch1Observability(
    batch1: Batch1Result,
    keys: { pipelineRunId: string; applicationId: string | null },
): void {
    const { experienceAgentDiag, projectsAgentDiag, skillsAgentDiag, analysis } = batch1;
    if (experienceAgentDiag) {
        logExperienceAgentEvents(log, { pipelineRunId: keys.pipelineRunId, applicationId: keys.applicationId, traceId: null }, experienceAgentDiag);
        const { outcome, reason } = experienceAgentOutcome(experienceAgentDiag);
        experienceOutcomeMetric.inc({ outcome, reason });
        if (experienceAgentDiag.targets.length > 0 && !experienceAgentDiag.fallback.fired) {
            experienceAgentCoverageMetric.observe(experienceAgentDiag.coverageBefore.covered);
        }
    }
    recordProjectsAgentObservability(projectsAgentDiag, keys);
    recordSkillsAgentObservability(skillsAgentDiag, keys);
    recordAnalysisAgentObservability(analysis.data, keys);
}

/**
 * Skills-agent observability (Task 9): Loki event stream + bounded
 * Prometheus outcome/reason metric, derived from fillResumeSkills's returned
 * diagnostics via the shared section-agent-diagnostics.ts emitter/mapper.
 * Guards the null-diag case (no writer target) internally, same shape as
 * recordProjectsAgentObservability.
 */
function recordSkillsAgentObservability(
    diag: SkillsAgentDiagnostics | null,
    keys: { pipelineRunId: string; applicationId: string | null },
): void {
    if (!diag) return;
    logSectionAgentEvents(log, { pipelineRunId: keys.pipelineRunId, applicationId: keys.applicationId, traceId: null }, 'skills_agent', skillsAgentEvents(diag));
    const { outcome, reason } = skillsAgentOutcome(diag);
    skillsOutcomeMetric.inc({ outcome, reason });
}

/**
 * Analysis-agent observability (Task 9): Loki event stream only -- no
 * Prometheus outcome counter (analysis failure aborts the whole run and is
 * already visible in the pipeline_runs status transition; see
 * analysisAgentSummary's doc comment). The compact summary object is folded
 * into pipeline_runs.metadata.analysis.analysisAgent separately (main()).
 */
function recordAnalysisAgentObservability(
    analysisData: StrategistAnalysisResult,
    keys: { pipelineRunId: string; applicationId: string | null },
): void {
    logSectionAgentEvents(log, { pipelineRunId: keys.pipelineRunId, applicationId: keys.applicationId, traceId: null }, 'analysis_agent', analysisAgentEvents(analysisData));
}

/**
 * sectionOrder for the reconciled resume. The pre-split writer emitted this
 * field itself (an archetype-driven render-order decision baked into its
 * single resume-JSON tool call); the analysis agent authors no resume JSON,
 * so nothing downstream of the split can emit it anymore.
 *
 * DECISION: always undefined (renderer falls back to its own canonical
 * order). Checked against prompts/content/constraints/role-archetypes.md --
 * its ONLY archetype with an explicit `sectionOrder:` line (Archetype 7)
 * lists the EXACT SAME order as the generic template example in
 * _base_1.md's tool-call sample: summary, experience, projects, education,
 * skills, certifications. No archetype in that doc actually reorders
 * top-level sections -- the "lead with" guidance there is about WITHIN-
 * section bullet emphasis, not section order -- so there is no archetype-
 * implied order to derive from analysis.data.archetypeSelection. `undefined`
 * here preserves today's EFFECTIVE behaviour, not a regression.
 */
function analysisSectionOrder(_analysis: StrategistAnalysisResult): string[] | undefined {
    return undefined;
}

/**
 * Reconcile the batch-1 output against the single-source TailoredResumeSchema
 * and refuse-empty required sections (resume-reconciler.ts). Logs which
 * sections were repaired (observability parity with the fill-lane fallback
 * logs above) -- repaired == [] is the overwhelmingly common case (each
 * filler already has its own fallback; this is the second-layer safety net).
 */
function reconcileResumeSections(
    resume: StructuredResumeData,
    sectionOrder: string[] | undefined,
    fallbacks: ReconcileInputs['fallbacks'],
    pipelineRunId: string,
): StructuredResumeData {
    const { resume: reconciled, repaired } = reconcileResume({ resume, sectionOrder, fallbacks });
    if (repaired.length > 0) {
        log.warn({ pipelineRunId, repaired }, 'resume_sections_repaired_by_reconciler');
    }
    return reconciled;
}

interface Batch2Result {
    readonly summaryAtsDiag: SummaryAtsDiagnostics | null;
    readonly coverLetter: CoverLetter | null;
    readonly coverLetterAgentResult: CoverLetterAgentResult;
}

/**
 * Cover-letter fill -- wraps executeCoverLetterAgent with the
 * CoverLetterAgentResult shape (requested/failed) the shared
 * section-agent-diagnostics.ts emitter/mapper need, so the caller
 * (runBatch2Agents) stays a plain Promise.all with no branching of its own.
 * Never rejects: `coverLetterInput === null` (not requested) resolves
 * immediately; an executeCoverLetterAgent rejection is caught and logged,
 * same fail-open contract every other section-agent lane has.
 */
async function fillCoverLetter(
    ctx: StrategistPipelineContext,
    coverLetterInput: CoverLetterMessageInput | null,
    pipelineRunId: string,
): Promise<{ letter: CoverLetter | null; result: CoverLetterAgentResult }> {
    if (!coverLetterInput) return { letter: null, result: { requested: false, failed: false } };
    try {
        const res = await executeCoverLetterAgent(ctx, coverLetterInput);
        return { letter: res.data, result: { requested: true, failed: false } };
    } catch (err) {
        log.warn({ pipelineRunId, agent: 'strategist-cover-letter', err: err instanceof Error ? err.message : String(err) }, 'cover_letter_agent_failed_no_letter');
        return { letter: null, result: { requested: true, failed: true } };
    }
}

/**
 * Batch 2 -- the summary agent and the cover-letter agent run CONCURRENTLY
 * once batch 1 + reconcile have produced the finished experience/projects/
 * skills body. Both read that same assembled resume snapshot: the summary
 * agent grounds its ATS coverage rewrite against it, and the cover-letter
 * agent's lead echoes its strongest JD-relevant achievement (see
 * cover-letter-message.ts's resumeBodyEchoSection). Because both run
 * CONCURRENTLY, the snapshot the cover-letter agent sees does NOT yet
 * include the summary text fillResumeSummary is writing in the other half
 * of this same Promise.all -- cover-letter-message.ts already degrades
 * gracefully for that case (falls back to the achievement-evidence block
 * for its lead when the echo section has no summary to draw on). Trading a
 * slightly less complete echo for the parallelism is the whole point of
 * this task (the sequential pre-split writer cost ~6 minutes end to end).
 *
 * Cover letter is optional (ctx.includeCoverLetter, default true) and is
 * caller-gated to null via `coverLetterInput` -- it never rejects the batch
 * on failure (caught + logged, same fail-open contract every other
 * section-agent lane has).
 */
async function runBatch2Agents(args: {
    ctx: StrategistPipelineContext;
    resume: StructuredResumeData;
    researchData: StrategistResearchResult;
    profileIntelligenceBlock: string;
    yearsGap: YearsGapLite;
    achievementEvidenceBlock: string;
    summaryAtsTargets: readonly SummaryAtsTarget[];
    coverLetterInput: CoverLetterMessageInput | null;
    pipelineRunId: string;
}): Promise<Batch2Result> {
    const {
        ctx, resume, researchData, profileIntelligenceBlock, yearsGap,
        achievementEvidenceBlock, summaryAtsTargets, coverLetterInput, pipelineRunId,
    } = args;
    const [summaryAtsDiag, coverLetterOutcome] = await Promise.all([
        fillResumeSummary(
            ctx, resume, researchData, profileIntelligenceBlock, yearsGap, achievementEvidenceBlock,
            summaryAtsTargets, summaryOutcomeMetric,
            (err) => log.warn({ pipelineRunId, agent: 'strategist-summary', error: err instanceof Error ? err.message : String(err) }, 'summary_agent_failed_deterministic_fallback_used'),
        ),
        fillCoverLetter(ctx, coverLetterInput, pipelineRunId),
    ]);
    return { summaryAtsDiag, coverLetter: coverLetterOutcome.letter, coverLetterAgentResult: coverLetterOutcome.result };
}

/**
 * Cover-letter agent observability (Task 9): Loki event stream + bounded
 * Prometheus outcome/reason metric, derived from fillCoverLetter's returned
 * CoverLetterAgentResult via the shared section-agent-diagnostics.ts
 * emitter/mapper. Unlike recordSkillsAgentObservability there is no
 * null-diag case -- fillCoverLetter always returns a result.
 */
function recordCoverLetterAgentObservability(
    res: CoverLetterAgentResult,
    keys: { pipelineRunId: string; applicationId: string | null },
): void {
    logSectionAgentEvents(log, { pipelineRunId: keys.pipelineRunId, applicationId: keys.applicationId, traceId: null }, 'cover_letter_agent', coverLetterAgentEvents(res));
    const { outcome, reason } = coverLetterAgentOutcome(res);
    coverLetterOutcomeMetric.inc({ outcome, reason });
}

/**
 * Guards stage -- cover-letter guard (rule-based, rewrite-on-violation) +
 * the project-to-experience relocation + resume guard (F-pattern content
 * checks). Both guard passes are fail-open (guardCoverLetter/guardResume
 * never throw). Moved verbatim from main() into a named function -- the
 * INPUT `resume` here is always the reconciled, non-null batch-1 output
 * (resume-reconciler.ts's refuse-empty guarantee), so this stage (and every
 * stage after it) never needs a null guard the pre-split pipeline carried
 * for the case the writer failed outright.
 */
async function runGuardsStage(args: {
    coverLetterCandidate: CoverLetter | null;
    targetRole: string;
    leadIdentity: string;
    letterFraming: string;
    coverLetterNarrative: CoverLetterNarrativeOpts;
    resume: StructuredResumeData;
    resumeGuardCtx: ResumeGuardCtx;
    projectResumeBullets: ReadonlyArray<ProjectResumeBulletSet>;
    violationLog: ViolationLog;
}): Promise<{ finalCoverLetter: CoverLetter | null; resume: StructuredResumeData; relocatedSnapshot: StructuredResumeData }> {
    const { coverLetterCandidate, targetRole, leadIdentity, letterFraming, coverLetterNarrative, resume, resumeGuardCtx, projectResumeBullets, violationLog } = args;

    const { letter: finalCoverLetter, violations: coverViolations } = await guardCoverLetter(
        coverLetterCandidate, targetRole, leadIdentity, letterFraming, coverLetterNarrative,
    );
    violationLog.recordAll('cover_letter', coverViolations);

    // Keep Experience to verified employers: relocate any agent-mis-filed
    // "Solo <role> — <Project>" experience entry back into
    // projects[].highlights (its github link + description live there). Runs
    // BEFORE the guard so every downstream pass sees the corrected structure.
    const relocated = relocateProjectExperience(resume, resumeGuardCtx.verifiedEmployers ?? [], projectResumeBullets);
    const beforeGuardProj = projSnapshot(relocated);
    let guardViolations: ResumeViolation[] = [];
    const guardedResume = await withExperienceLock(relocated, 'guard', async (r) => {
        const guarded = await guardResume(r, resumeGuardCtx);
        guardViolations = guarded.violations;
        return guarded.resume;
    }, (pass) => {
        sectionNetFiredMetric.inc({ section: 'experience', pass, outcome: 'restored' });
        violationLog.record('resume_guard', 'experience_lock_restored');
    });
    trackNetFired('guard', expSnapshot(relocated), expSnapshot(guardedResume), beforeGuardProj, projSnapshot(guardedResume));
    violationLog.recordAll('resume_guard', guardViolations);

    return { finalCoverLetter, resume: guardedResume, relocatedSnapshot: relocated };
}

/**
 * Length stage -- migration reframe + length budget (measure -> condense ->
 * hard trim) + grounded-metric weave + final content re-validation +
 * integrity restore. Moved verbatim from main() into a named function; the
 * `writerOriginal` baseline for applyResumeIntegrity/preserveResumeFields is
 * the RECONCILED pre-guard resume (`baseline` here), same as the pre-split
 * pipeline used the writer's raw output for that baseline.
 */
async function runLengthStage(args: {
    resume: StructuredResumeData;
    baseline: StructuredResumeData;
    projectHighlightsSnapshot: StructuredResumeData;
    resumeGuardCtx: ResumeGuardCtx;
    jdPriority: JdPriorityContext;
    budgetGroundingFacts: string;
    groundedMetricsBlock: string;
    targetRole: string;
    requiredSkills: readonly string[];
    succeedsEdges: ReadonlyMap<string, ReadonlySet<string>>;
    codeTechByRepo: ReadonlyMap<string, ReadonlySet<string>>;
    aliasToCanonical: ReadonlyMap<string, string>;
    violationLog: ViolationLog;
    pipelineRunId: string;
}): Promise<StructuredResumeData> {
    const {
        resume, baseline, projectHighlightsSnapshot, resumeGuardCtx, jdPriority, budgetGroundingFacts,
        groundedMetricsBlock, targetRole, requiredSkills, succeedsEdges, codeTechByRepo, aliasToCanonical,
        violationLog, pipelineRunId,
    } = args;

    // Career/bullet drift: reframe an experience bullet describing a tech the code
    // has since superseded (e.g. self-hosted kubeadm → managed EKS) into an honest
    // migration narrative. Deterministic detection + grounded Haiku reframe; fail-open.
    let current = resume;
    const staleMigrations = detectStaleMigrations(current, { succeedsEdges, codeTechByRepo, aliasToCanonical });
    if (staleMigrations.length > 0) {
        log.warn({
            pipelineRunId,
            migrations: staleMigrations.map((m) => ({ predecessor: m.predecessor, successors: m.successors })),
        }, 'migration_reframe_fired');
        const preReframe = current;
        current = await withExperienceLock(preReframe, 'reframe', async (r) =>
            preserveExperienceRoster(r, await reframeStaleMigrations(r, staleMigrations).catch(() => r)),
        (pass) => {
            sectionNetFiredMetric.inc({ section: 'experience', pass, outcome: 'restored' });
            violationLog.record('migration_reframe', 'experience_lock_restored');
        });
    }

    // ── Length budget (measure → condense → hard trim; fail-open) ──
    // The 2026-07-02 Google run shipped 1,723 words / 4 pages: the
    // strategist emitted 1,045 and the guard + keyword rewrites added
    // the rest. Enforce here (before persist/ATS) and again after the
    // keyword-surfacing rewrite — the last stage that can grow it.
    const preBudget = current;
    const allowedNumbers = extractNumbers([JSON.stringify(preBudget), budgetGroundingFacts].join(' '));
    const beforeLengthProj = projSnapshot(preBudget);
    const budgeted = await withExperienceLock(preBudget, 'length', (r) =>
        applyLengthBudget(r, jdPriority, (v) => violationLog.record('length_budget', v.code), { groundingFacts: budgetGroundingFacts }).catch(() => r),
    (pass) => {
        sectionNetFiredMetric.inc({ section: 'experience', pass, outcome: 'restored' });
        violationLog.record('length_budget', 'experience_lock_restored');
    });
    trackNetFired('length', expSnapshot(preBudget), expSnapshot(budgeted), beforeLengthProj, projSnapshot(budgeted));
    // Expansion may only add grounded numbers; strip anything else.
    const preMetrics = stripUngroundedNumbers(budgeted, allowedNumbers);
    // Metric weave (always-on when the ledger is non-empty): no agent sees
    // the ledger directly, so this Haiku pass is HOW grounded metrics enter
    // the bullets. Values are protected by the allowed-number set; the
    // number strip re-runs on its output.
    const jdContextLine = `${targetRole}: ${requiredSkills.join(', ')}`;
    // Experience is agent-owned (fillResumeExperience already produced a
    // provenance-guarded final section) -- the weave may still legitimately
    // rewrite project descriptions, so scope it OUT of experience via the
    // shared lock (experience-lock.ts) rather than a bespoke snapshot.
    const numberSafe = await withExperienceLock(preMetrics, 'metric_weave', (r) =>
        weaveGroundedMetrics(r, groundedMetricsBlock, budgetGroundingFacts, allowedNumbers, jdContextLine, (code) => {
            violationLog.record('metric_weave', code);
            log.warn({ pipelineRunId, code }, 'grounded_metric_weave');
        }),
    (pass) => {
        sectionNetFiredMetric.inc({ section: 'experience', pass, outcome: 'restored' });
        violationLog.record('metric_weave', 'experience_lock_restored');
    });
    // FINAL content re-validation: reframe/condense/expand can
    // reintroduce violations the early guard already repaired (the
    // A/B run regained 5 bullet-shared project numbers and a flat
    // "Terraform" claim). One bounded repair, then report residuals.
    let revalidateViolations: ResumeViolation[] = [];
    const revalidatedResume = await withExperienceLock(numberSafe, 'revalidate', async (r) => {
        const revalidated = await revalidateResumeContent(r, resumeGuardCtx).catch(() => ({ resume: r, violations: [] as ResumeViolation[] }));
        revalidateViolations = revalidated.violations;
        return revalidated.resume;
    }, (pass) => {
        sectionNetFiredMetric.inc({ section: 'experience', pass, outcome: 'restored' });
        violationLog.record('revalidate', 'experience_lock_restored');
    });
    violationLog.recordAll('revalidate', revalidateViolations);
    let finalResume = await applyResumeIntegrity(revalidatedResume, baseline, allowedNumbers, (code) => violationLog.record('resume_integrity', code));
    // Restore any projects[].highlights the Haiku re-emit passes dropped
    // (the emit_resume tool round-trip blanks the Projects bullets).
    finalResume = restoreProjectHighlights(projectHighlightsSnapshot, finalResume);
    return finalResume;
}

/** Everything runAtsGateStage needs -- one wide args object (orchestration function, mirrors RunProvenanceInputs above). */
interface AtsGateArgs {
    readonly pool: Pool;
    readonly env: { applicationId: string; userId: string; pipelineId: string; targetRole: string; pipelineRunId: string };
    readonly researchData: StrategistResearchResult;
    readonly jdExtraction: JdSignal;
    readonly familyVocab: string[][];
    readonly techGroups: string[][];
    readonly techAliasMap: Map<string, string>;
    readonly skillEvidenceLedger: readonly SkillEvidenceEntry[];
    readonly resumeGuardCtx: ResumeGuardCtx;
    readonly jdPriority: JdPriorityContext;
    readonly experienceFactsBlock: string;
    readonly projectEvidenceBlock: string;
    readonly baseline: StructuredResumeData;
    readonly projectHighlightsSnapshot: StructuredResumeData;
    readonly violationLog: ViolationLog;
    readonly persistedResumeId: string;
    readonly resume: StructuredResumeData;
    readonly archetype: string | null;
}

/**
 * ATS-gate stage -- render + parse-back QA, then the attainable-keyword
 * feedback loop (ONE bounded honest re-write + re-check). Moved verbatim
 * from main() into a named function; every internal step keeps its original
 * fail-open contract (errors here degrade the ATS verdict, never fail the
 * run).
 */
async function runAtsGateStage(args: AtsGateArgs): Promise<{ finalResume: StructuredResumeData; finalAts: AtsCheckResult | null }> {
    const {
        pool, env, researchData, jdExtraction, familyVocab, techGroups, techAliasMap, skillEvidenceLedger,
        resumeGuardCtx, jdPriority, experienceFactsBlock, projectEvidenceBlock, baseline,
        projectHighlightsSnapshot, violationLog, persistedResumeId, archetype,
    } = args;
    let finalResume = args.resume;

    // Build a shared embedder for 3-tier ATS keyword matching (Titan, fail-open).
    const atsEmbedder = TitanEmbeddingProvider.fromEnvironment();
    const atsArgs = {
        s3, pool,
        bucket:        process.env['ASSETS_BUCKET'] ?? '',
        resumeId:      persistedResumeId,
        userId:        env.userId,
        research:      researchData,
        log,
        correlationId: env.pipelineRunId,
        onOutcome:     (status: AtsCheckResult['status'] | 'error') => strategistRuns.inc({ operation: 'analyse', outcome: `ats_${status}` }),
        jdExtraction,
        familyVocab,
        embedder:      atsEmbedder,
        techGroups,
        techAliasMap,
    };
    const atsCheck = await renderCheckAndStoreAts({ ...atsArgs, resume: finalResume });
    let finalAts: AtsCheckResult | null = atsCheck;
    // Tracks whichever resumes row holds the FINAL ATS check (the
    // keyword-surfacing re-write below may persist a different
    // resumeId) — F6 re-stores the attainable-enriched object onto
    // this row after the merge below.
    let atsResumeId = persistedResumeId;

    // ── ATS feedback loop (pass-by-generation, ONE bounded honest re-write) ──
    // Surface attainable-but-missing keywords (verified/transferable the
    // candidate genuinely has — GAPs are excluded by splitAttainable and
    // can never be surfaced) using ONLY the provided evidence, then re-render
    // + re-check ONCE. Fail-open at every await; never throws.
    const split = splitAttainable(atsCheck.jdKeywordCoverage, skillEvidenceLedger);
    if (split.attainableMissing.length > 0) {
        atsFeedback.inc({ outcome: 'fired' });
        const baseResume = finalResume;
        // Red flags: no structured red-flag source exists in this scope today
        // (StrategistResearchResult has no `redFlags`, no recruiter snapshot here) → [].
        const redFlags: string[] = [];
        // Grounding facts = verbatim career facts + project evidence only (F2:
        // verifiedMatches[].sourceCitation is a matcher paraphrase, not verbatim
        // KB text, and must never seed the allowed-number set — see grounding-facts.ts).
        const groundingFacts = buildGroundingFacts([
            experienceFactsBlock,
            projectEvidenceBlock,
        ]);
        // Allowed numbers = original resume + grounding facts. Any number the
        // rewrite introduces outside this set is stripped deterministically.
        const allowed = extractNumbers([JSON.stringify(baseResume), groundingFacts].join(' '));
        const beforeSurfaceProj = projSnapshot(baseResume);
        let surfaced = await withExperienceLock(baseResume, 'surface_keywords', async (r) => {
            const refined = preserveExperienceRoster(r, await surfaceKeywords(r, split.attainableMissing, { redFlags, groundingFacts }).catch(() => r));
            return refined === r ? r : stripUngroundedNumbers(refined, allowed);
        }, (pass) => {
            sectionNetFiredMetric.inc({ section: 'experience', pass, outcome: 'restored' });
            violationLog.record('surface_keywords', 'experience_lock_restored');
        });
        trackNetFired('surface_keywords', expSnapshot(baseResume), expSnapshot(surfaced), beforeSurfaceProj, projSnapshot(surfaced));
        if (surfaced !== baseResume) {
            // The keyword rewrite is the last stage that can GROW the
            // resume (it inflated the 2026-07-02 Google run by pulling
            // grounding-facts prose into projects) — re-enforce the
            // length budget, then FINAL-revalidate content (surface
            // rewrites were observed reintroducing inventory numbers
            // and unbridged claims) before persisting and re-checking.
            // No groundingFacts here: round 1 already expanded to fill;
            // this pass exists only to SHRINK keyword-rewrite overgrowth.
            // (Observed live: a second expand+revalidate round cost ~50s.)
            // scrubEvidenceText (F3): the condense rewrite this triggers
            // interpolates its own numeric budgets into the prompt next to
            // the resume text — feed it real evidence so a genuinely
            // grounded number survives the post-condense instruction-leak
            // scrub, without opting back into the expand direction.
            const beforePostKeywordsExp = expSnapshot(surfaced);
            const beforePostKeywordsLengthProj = projSnapshot(surfaced);
            surfaced = await withExperienceLock(surfaced, 'length', (r) =>
                applyLengthBudget(r, jdPriority, (v) => violationLog.record('length_budget_post_keywords', v.code), { scrubEvidenceText: groundingFacts }).catch(() => r),
            (pass) => {
                sectionNetFiredMetric.inc({ section: 'experience', pass, outcome: 'restored' });
                violationLog.record('length_budget_post_keywords', 'experience_lock_restored');
            });
            trackNetFired('length', beforePostKeywordsExp, expSnapshot(surfaced), beforePostKeywordsLengthProj, projSnapshot(surfaced));
            surfaced = stripUngroundedNumbers(surfaced, allowed);
            let revalPostKeywordsViolations: ResumeViolation[] = [];
            surfaced = await withExperienceLock(surfaced, 'revalidate', async (r) => {
                const reval = await revalidateResumeContent(r, resumeGuardCtx).catch(() => ({ resume: r, violations: [] as ResumeViolation[] }));
                revalPostKeywordsViolations = reval.violations;
                return reval.resume;
            }, (pass) => {
                sectionNetFiredMetric.inc({ section: 'experience', pass, outcome: 'restored' });
                violationLog.record('revalidate_post_keywords', 'experience_lock_restored');
            });
            violationLog.recordAll('revalidate_post_keywords', revalPostKeywordsViolations);
            surfaced = await applyResumeIntegrity(surfaced, baseline, allowed, (code) => violationLog.record('resume_integrity_post_keywords', code));
            // close the silent-blanking path: the keyword-loop re-emit can drop projects[].highlights
            surfaced = restoreProjectHighlights(projectHighlightsSnapshot, surfaced);
            finalResume = surfaced;
            const rePersisted = await persistTailoredResume(pool, {
                applicationId:  env.applicationId,
                userId:         env.userId,
                pipelineId:     env.pipelineId,
                targetRole:     env.targetRole,
                archetype,
                tailoredResume: surfaced,
            }).catch(() => null);
            const reResumeId = rePersisted?.resumeId ?? persistedResumeId;
            atsResumeId = reResumeId;
            // Re-check the SURFACED resume. A silent fallback to the
            // pre-rewrite verdict shipped stale "missing keyword" issues
            // for a resume that had already fixed them — so retry once,
            // and if the re-check still fails, mark the verdict stale
            // instead of presenting it as current.
            finalAts = await renderCheckAndStoreAts({ ...atsArgs, resumeId: reResumeId, resume: surfaced })
                .catch(async () => {
                    log.warn({ pipelineRunId: env.pipelineRunId }, 'ats_recheck_failed — retrying once');
                    return renderCheckAndStoreAts({ ...atsArgs, resumeId: reResumeId, resume: surfaced });
                })
                .catch(() => {
                    log.warn({ pipelineRunId: env.pipelineRunId }, 'ats_recheck_failed_twice — stamping stale verdict');
                    strategistRuns.inc({ operation: 'analyse', outcome: 'ats_recheck_stale' });
                    return { ...atsCheck, staleForFinalResume: true };
                });
        }
    } else {
        atsFeedback.inc({ outcome: 'skipped' });
    }

    // Stamp the pass-mark from the FINAL coverage, then reconcile the
    // headline `passed` bit (F5). `status` (buildAtsCheck, GROUNDED
    // keywords) and `attainablePassed` (splitAttainable, VERIFIED-only)
    // measure different things and can legitimately disagree —
    // reconcileAtsPassed is the single arbiter; emit ONE reconciled
    // outcome from it rather than reading `finalSplit.attainablePassed`
    // and the per-render `ats_${status}` outcome as two independent
    // (and possibly conflicting) truths.
    const finalSplit = splitAttainable(finalAts.jdKeywordCoverage, skillEvidenceLedger);
    const reconciledPassed = reconcileAtsPassed(finalAts.status, finalSplit.attainablePassed);
    if (reconciledPassed) atsFeedback.inc({ outcome: 'passed' });
    finalAts = {
        ...finalAts,
        passed:            reconciledPassed,
        attainableTotal:   finalSplit.attainableTotal,
        attainableCovered: finalSplit.attainableCovered,
        attainablePassed:  finalSplit.attainablePassed,
        surfacedKeywords:  split.attainableMissing.map((e) => e.tool),
    };

    // F6: renderCheckAndStoreAts already persisted the PRE-attainable
    // check to resumes.ats_check_json via storeAtsArtifacts. The
    // attainable fields + reconciled `passed` only become known here,
    // after the Skill Evidence Ledger split — re-store the enriched
    // object so the primary read path (resumes.ats_check_json) carries
    // the same truth as pipeline_runs.metadata.analysis.atsCheck
    // instead of only the latter.
    await storeAtsCheckJson({ pool, userId: env.userId, resumeId: atsResumeId, check: finalAts }).catch((e) => {
        log.warn(
            { pipelineRunId: env.pipelineRunId, resumeId: atsResumeId, error: (e as Error).message },
            'ats_check_json_attainable_restore_failed — resumes.ats_check_json lacks attainable fields; pipeline_runs.metadata still has them',
        );
    });

    return { finalResume, finalAts };
}

export async function main(): Promise<void> {
    const env  = parseEnv();
    const pool = getPool(env.pg);

    // ── Free-tier fast path — early return, never falls through to the paid pipeline ──
    if (isFreeMode(env)) {
        const store = RdsVectorStore.fromEnvironment();
        try {
            await runFreeTier(pool, env, {
                extractJdSignal,
                gather: (p, e, jd) => gatherFreeEvidence(p, e, jd, {
                    retrieve: (query) => querySingleRds(query, e.userId, store),
                }),
                writer:        bedrockFreeResumeWriter,
                aliasMap:      (p) => new SkillOntologyRepository(p).loadAliasToCanonicalMap(),
                persistResume: persistTailoredResume,
                persistMeta:   updatePipelineRunMetadata,
                setStatus:     updateJobApplicationStatus,
                complete:      updatePipelineRun,
            });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const clientMessage = outputSanitiser.sanitise(message).slice(0, 500);
            await updatePipelineRun(pool, env.pipelineRunId, 'failed', clientMessage)
                .catch(() => { /* swallow — already failing */ });
            await updateJobApplicationStatus(pool, env.applicationId, 'failed')
                .catch(() => { /* swallow — already failing */ });
            throw err;
        } finally {
            await closePool();
        }
        return; // free path is terminal — never falls through to the paid pipeline
    }

    const start = process.hrtime.bigint();
    let outcome: 'success' | 'failed' = 'failed';

    // Fetch the user's active resume from PG if RESUME_ID is provided.
    // Done here rather than inside the research agent so the structured JSON
    // is available to the strategist agent as Phase 1 input without an
    // extra PG round-trip mid-pipeline.
    let resumeData: unknown = null;
    if (env.resumeId) {
        const result = await pool.query<{ content_json: unknown }>(
            `SELECT content_json FROM resumes WHERE id = $1 AND (user_id = $2 OR user_id IS NULL)`,
            [env.resumeId, env.userId],
        );
        resumeData = result.rows[0]?.content_json ?? null;
        if (resumeData) {
            log.info({ pipelineRunId: env.pipelineRunId, resumeId: env.resumeId }, 'resume_loaded_from_pg');
        } else {
            log.warn({ pipelineRunId: env.pipelineRunId, resumeId: env.resumeId }, 'resume_not_found_in_pg');
        }
    }

    // Construct the StrategistPipelineContext required by the agents.
    //
    // Notes on field provenance:
    //  - resumeId / resumeData: resolved above via PG lookup when RESUME_ID is
    //    provided by admin-api at dispatch time.
    //  - bucket: artefact bucket for any S3 offload paths in the agents.
    //  - operation: hard-coded to 'analyse' — the coach pipeline is a separate
    //    Job entrypoint.
    //  - interviewStage: defaults to 'applied' for the analyse path.
    // Single authoritative JD sanitisation (injection-strip + PII-scrub) at
    // pipeline entry. Every consumer — JD-extractor, Research, semantic cache —
    // inherits this neutralised value via ctx.jobDescription, instead of each
    // re-deriving it (and the extractor/cache previously skipping injection-strip).
    const { clean: cleanJobDescription, warnings: jdWarnings, injectionDetected } =
        sanitiseJobDescription(env.jobDescription);
    if (injectionDetected) {
        log.warn({ pipelineRunId: env.pipelineRunId }, 'JD injection attempt detected — proceeding with sanitised input');
    }
    for (const w of jdWarnings) {
        log.warn({ pipelineRunId: env.pipelineRunId, warning: w }, 'jd_sanitise_warning');
    }

    const ctx: StrategistPipelineContext = {
        pipelineId:        env.pipelineId,
        operation:         'analyse',
        applicationSlug:   env.applicationSlug,
        jobDescription:    cleanJobDescription,
        targetCompany:     env.targetCompany,
        targetRole:        env.targetRole,
        resumeId:          env.resumeId,
        resumeData:        resumeData as StructuredResumeData | null,
        interviewStage:    'applied',
        bucket:            process.env['S3_BUCKET'] ?? '',
        environment:       env.environment,
        cumulativeTokens:  { input: 0, output: 0, thinking: 0 },
        cumulativeCostUsd: 0,
        startedAt:         new Date().toISOString(),
        userId:            env.userId,
        onInvocationComplete: recordInvocationToRds(pool, 'job-strategist', { applicationId: env.applicationId }),
    };
    // Process-wide fallback: helper agents (guards, years-gap, surface-keywords,
    // condense) and the matcher build their own contexts without the sink —
    // register it once so EVERY Bedrock invocation in this Job records to
    // prompt_invocations with user attribution.
    setDefaultAgentInvocationSink(
        recordInvocationToRds(pool, 'job-strategist', { applicationId: env.applicationId }),
        env.userId,
    );

    try {
        await updatePipelineRun(pool, env.pipelineRunId, 'researching');
        await updateJobApplicationStatus(pool, env.applicationId, 'analysing');

        // ── Semantic cache short-circuit (fail-open) ──────────────────────
        // The JD is PII-scrubbed before it ever becomes the cache key so no
        // raw PII reaches the embedding model or the cache table. Any cache
        // failure degrades to a normal (uncached) run — never a hard-fail.
        // A hit reproduces the exact terminal run-state of a successful run.
        // Scope on the user ONLY. targetRole/targetCompany are free-text user
        // inputs ("Sr" vs "Senior", trailing spaces), so keying the scope on
        // them partitioned near-identical applications into disjoint cache rows
        // (live data: 1 row, 0 hits ever). They still take part in matching,
        // but semantically — prepended to the query text below, where the
        // cosine threshold tolerates phrasing variance instead of requiring
        // byte equality.
        const cacheScope = `jobstrat:${env.userId}`;
        // Fail-open: any throw from cacheTagFor degrades to a model-only tag so
        // the cache still partitions by model and the run never hard-fails.
        let cacheTag = `:${process.env['STRATEGIST_MODEL'] ?? 'default'}`;
        try { cacheTag = await cacheTagFor(pool, env.userId); } catch { /* fail-open: model-only tag */ }
        // JD already sanitised once at entry. Role/company lead the text so two
        // runs of the same JD against different roles stay distinguishable.
        const jdForCache = `${env.targetRole} @ ${env.targetCompany}\n${ctx.jobDescription}`;
        let cached: { hit: boolean; response?: unknown } = { hit: false };
        try {
            cached = (await semanticCache.get({ scope: cacheScope, kbTag: cacheTag, queryText: jdForCache })) ?? { hit: false };
        } catch (e) {
            log.warn({
                pipelineRunId: env.pipelineRunId,
                error: (e as Error).message,
            }, 'Semantic cache get failed — proceeding without cache');
            cached = { hit: false };
        }
        if (cached.hit && cached.response && typeof (cached.response as { analysis?: { analysisXml?: unknown } }).analysis?.analysisXml === 'string') {
            const cr = cached.response as {
                analysis: {
                    analysisXml: string;
                    tailoredResumeData?: unknown;
                    archetypeSelection?: { selectedArchetype?: string | null };
                    [k: string]: unknown;
                };
                research: unknown;
            };
            await updatePipelineRunMetadata(pool, env.pipelineRunId, {
                analysis: cr.analysis,
                research: cr.research,
            });
            // Reproduce the exact terminal state of a normal run: persist the
            // cached tailored resume so admin-api detail and the downstream
            // coach Job see a resume row. Older cached entries predate this
            // field — when absent, proceed without it (matches a run that
            // produced no resume). Mirrors the normal success-path call.
            if (cr.analysis?.tailoredResumeData) {
                await persistTailoredResume(pool, {
                    applicationId:  env.applicationId,
                    userId:         env.userId,
                    pipelineId:     env.pipelineId,
                    targetRole:     env.targetRole,
                    archetype:      cr.analysis?.archetypeSelection?.selectedArchetype ?? null,
                    tailoredResume: cr.analysis.tailoredResumeData,
                });
            }
            await updateJobApplicationStatus(pool, env.applicationId, 'analysis-ready');
            await updatePipelineRun(pool, env.pipelineRunId, 'complete');
            outcome = 'success';
            log.info({
                pipelineRunId: env.pipelineRunId,
                applicationId: env.applicationId,
            }, 'strategist_pipeline_complete');
            return;
        }

        // Guard-violation ledger: every (stage, code) pair fired below is
        // collected for pipeline_runs.metadata.guard — Prometheus counters
        // alone do not survive short-lived Job pods (run 77e325ea: three
        // rewrites fired, zero increments visible after the pod exited).
        // Declared here (moved up from its old post-writer position) so the
        // roster-reconcile call on the skeleton, below, can record into it.
        const violationLog = createViolationLog((stage, code) =>
            (stage === 'cover_letter' ? coverLetterViolations : resumeViolationsMetric).inc({ code }));

        // Independent pre-research inputs, loaded CONCURRENTLY (were sequential):
        //  - project case studies (citeable evidence for grounding + resume bullets)
        //  - education facts (verbatim degree/institution — no hallucinated schools)
        //  - careerEntries: loaded ONCE here and shared by the experience-facts block
        //    AND the Research agent's career history (was loaded twice)
        //  - JD-extractor: structured JD signal that sharpens KB retrieval
        // All fail-open.
        const [projectEvidenceBlock, projectResumeBullets, projectLaneIndex, profileIntelligenceBlock, educationEntries, certificationEntries, careerEntries, jdExtraction, achievementEvidenceBlock, metricsLedgerBlock, candidateContact] = await Promise.all([
            loadProjectEvidenceBlock(pool, ctx.userId),
            loadProjectResumeBullets(pool, ctx.userId),
            loadProjectLaneIndex(pool, ctx.userId),
            loadProfileIntelligenceBlock(pool, ctx.userId),
            loadEducation(pool, ctx.userId).catch(() => []),
            loadCertifications(pool, ctx.userId).catch(() => []),
            loadCareerHistory(pool, ctx.userId).catch(() => []),
            extractJobDescription(ctx.jobDescription, ctx),
            loadAchievementEvidence(pool, ctx.userId),
            loadGroundedMetricsLedger(pool, ctx.userId),
            loadCandidateContact(pool, ctx.userId),
        ]);
        // Candidate grounding fed to RESEARCH (and the section agents' evidence
        // text): documented project case studies PLUS the code-grounded Profile
        // Intelligence. Both fail-open to '' independently. The research/section
        // agents receive the two blocks SEPARATELY — concatenating them buried the
        // profile block inside the case-studies wrapper (whose preamble scopes
        // usage to bullet grounding), and the persona's S3 "drawn from the
        // profile intelligence" instruction had no matching section to draw
        // from (run 77e325ea: S3 slot filled with a second rigor close).
        const candidateGroundingBlock = [projectEvidenceBlock, profileIntelligenceBlock].filter(Boolean).join('\n\n');
        // projectResumeBullets (structured form) is no longer formatted for a
        // writer prompt (the dedicated projects agent composes entries from
        // this same pool via loadProjectAgentInputs) -- it still anchors the
        // post-agent relocation pass below.
        const educationBlock      = formatEducation(educationEntries);
        const certificationsBlock = formatCertifications(certificationEntries);
        const experienceFactsBlock = formatExperienceFacts(careerEntries);
        // formatCandidateContact is pure (no I/O) -- deriving the formatted
        // block from the already-loaded structured contact avoids a second DB
        // round trip. Still needed downstream: the cover-letter agent's
        // VERBATIM signoff source (see cover-letter-message.ts).
        const candidateContactBlock = formatCandidateContact(candidateContact);

        // -- Deterministic resume skeleton -- BEFORE any agent runs --------
        // Profile/education/certifications copied verbatim from verified
        // sources; experience reduced to a roster (company/title/period,
        // highlights filled by fillResumeExperience in batch 1 below); every
        // agent-owned section starts empty (resume-skeleton.ts). No LLM
        // prose exists yet at this point, so there is nothing for the old
        // scrubInstructionLeaks pass to strip -- see the removal note where
        // the pre-split writer's scrub call used to run, further down.
        const skeleton = buildSkeletonResume({
            careerEntries,
            education:      educationEntries,
            certifications: certificationEntries,
            contact:        candidateContact ?? { name: '', email: '' },
        });
        // Anchor the roster to career-history truth (merge duplicated roles,
        // restore employer names) -- moved here from its old post-writer
        // position (it used to run on the WRITER's roster to fix LLM drift;
        // the skeleton's roster is already a 1:1 deterministic map from
        // careerEntries, so this call is now a defence against duplicate/
        // near-duplicate raw career-history rows rather than LLM drift, but
        // it is still the single source of that anchoring logic).
        const tailoredResumeData: StructuredResumeData | null = reconcileRosterAgainstCareer(
            skeleton,
            careerEntries,
            (code) => {
                violationLog.record('roster_reconcile', code);
                log.warn({ pipelineRunId: env.pipelineRunId, code }, 'experience_roster_reconciled');
            },
        );

        // Role-ontology grounding — translate experience into target-role vocabulary. Fail-open.
        const roleRepo = new RoleOntologyRepository(pool);
        const companyFraming = await roleRepo.loadCompanyFraming().catch(() => new Map());
        const resolved = await resolveRoleFamilies(
            pool, ctx.userId,
            (careerEntries ?? []).map((c) => ({ title: c.title, company: c.company, highlights: c.highlights })),
            roleRepo,
        ).catch(() => []);
        // B1 — stage JD demand-side signal: record JD required skills + tools as
        // vocabulary candidates for the families matched from the candidate's career.
        void stageJdLearning(
            roleRepo, ctx.userId, resolved,
            jdExtraction.requiredSkills,
            jdExtraction.technologyInventory.tools,
        ).catch(() => undefined);
        const roleEvidenceBlock = formatRoleEvidence(resolved, companyFraming);
        // Flatten vocabulary groups from resolved role families for ontology-tier ATS matching.
        const familyVocab = resolved
            .map((rr) => rr.family?.vocabulary ?? [])
            .filter((v) => v.length > 0);

        // Tech-ontology grounding — load transfer groups + alias map ONCE (fail-open).
        // Prefer the explicit relationship graph; fall back to category groups when sparse.
        const techRepo = new TechnologyOntologyRepository(pool);
        const [techTransferGroups, techCategoryGroups, techAliasMap, codeTechByRepo, succeedsEdges, aliasToCanonical, archetypeSignals, repoFilePaths, evidenceTopology, canonicalToCodeFiles] = await Promise.all([
            techRepo.loadTransferGroups().catch(() => [] as string[][]),
            techRepo.loadCategoryGroups().catch(() => [] as string[][]),
            techRepo.loadAliasMap().catch(() => new Map<string, string>()),
            techRepo.loadRepoCodeTech(env.userId).catch(() => new Map<string, Set<string>>()),
            techRepo.loadSucceedsEdges().catch(() => new Map<string, Set<string>>()),
            techRepo.loadAliasToCanonicalMap().catch(() => new Map<string, string>()),
            techRepo.loadRepoArchetypeSignals(env.userId).catch(() => new Map<string, Record<string, boolean>>()),
            techRepo.loadRepoFilePaths(env.userId).catch(() => new Map<string, Set<string>>()),
            techRepo.loadRepoEvidenceTopology(env.userId).catch(() => new Map<string, Record<string, unknown>>()),
            techRepo.loadCanonicalToCodeFiles(env.userId).catch(() => new Map<string, string[]>()),
        ]);
        const techGroups = techTransferGroups.length > 0 ? techTransferGroups : techCategoryGroups;

        // A5 — build grounded tech-transfer context for the matcher persona.
        // Lists only the groups relevant to THIS JD's tools (not the full ontology).
        const jdTools = [
            ...jdExtraction.technologyInventory.tools,
            ...jdExtraction.technologyInventory.languages,
        ];
        const techTransferContext = formatTechTransferContext(jdTools, techGroups, techAliasMap);
        // Doc-vs-code drift + repo identity: the authoritative current code stack per repo
        // AND each repo's deterministic profile (cdk-infra/k8s-platform/…, what it provisions).
        // Folded into one grounding block so the matcher prefers code over stale docs and
        // attributes work to the right repo (e.g. cdk-monitoring IS the EKS-via-CDK infra).
        const repoProfiles = buildRepoProfiles(codeTechByRepo, archetypeSignals, repoFilePaths, evidenceTopology);
        const codeStackContext = [buildCodeStackContext(codeTechByRepo), buildRepoProfileContext(repoProfiles)]
            .filter(Boolean).join('\n\n');

        // Filter-then-rank pre-filter (Increment 2): transfer-aware tech/skill + the
        // structural fork/junk gates over the chunk metadata stamp. Env-gated so it
        // ships dark; absent ⇒ today's pure-vector retrieval (fail-open).
        const retrievalPrefilter = await buildQueryRetrievalPrefilter(pool, jdExtraction, techGroups, aliasToCanonical);

        const research = await stageSeconds(pipelineStageSeconds, 'research', () =>
            executeResearchAgent(ctx, pool, candidateGroundingBlock, educationBlock, jdExtraction, careerEntries, roleEvidenceBlock, techTransferContext, codeStackContext, retrievalPrefilter, certificationsBlock));

        // Years-gap — honest relevant-years vs the JD bar + a non-apologetic framing line.
        // Computed BEFORE the guard chain so it can deterministically constrain the matcher's
        // own overallFitRating/gaps (see applyYearsGapReconcile). Fail-open.
        const hardYearsBar = jdExtraction.hardRequirements.some((r) => r.disqualifying === true && /year/i.test(r.context));
        const yearsGap = await buildYearsGap(
            (careerEntries ?? []).map((c) => ({ title: c.title, company: c.company, period: c.period, family: null, roleClass: null })),
            jdExtraction.experienceSignals.yearsExpected,
            hardYearsBar,
            new Date().getFullYear(),
        ).catch(() => null);

        // Vendor-provenance guard (deterministic): a competing vendor evidenced ONLY by
        // reference/example docs (e.g. an "OpenAI example" in a structured-output checklist
        // while the real stack is Bedrock/Anthropic) was VERIFIED by the LLM → demote to a
        // transferable partialMatch so it is never written as first-person production work.
        // Runs BEFORE the ledger + strategist so the correction propagates to both.
        const { matching: vendorGuarded, demotions } = demoteMisattributedVendors(research.data, { techGroups, techAliasMap, codeTechByRepo });
        if (demotions.length > 0) {
            log.warn({
                pipelineRunId: env.pipelineRunId,
                demoted: demotions.map((d) => ({ skill: d.skill, vendor: d.matchedVendor, files: d.evidenceFiles })),
            }, 'vendor_provenance_demoted_reference_only_competing_vendor');
        }

        // Doc-vs-code drift guard (deterministic): a documented technology superseded
        // by the repo's current code (doc names predecessor P; code lacks P but has a
        // `succeeds`-successor of P, e.g. self-hosted Kubernetes → EKS) is demoted to a
        // past-tense partialMatch so a stale doc is never presented as current work.
        const { matching: guardedMatching, contradictions } = demoteCodeContradictedMatches(vendorGuarded, { codeTechByRepo, succeedsEdges, aliasToCanonical });
        if (contradictions.length > 0) {
            log.warn({
                pipelineRunId: env.pipelineRunId,
                contradicted: contradictions.map((c) => ({ skill: c.skill, repo: c.repo, docTech: c.docTech, codeSuccessors: c.codeSuccessors })),
            }, 'code_truth_demoted_stale_documentation_claim');
        }
        // Education / degree reconciliation (deterministic): the JD degree requirement is a
        // soft requirement that the skill/tool-centric matcher never reconciled, so a relevant
        // qualification (e.g. a Higher Diploma in Computing) was silently dropped — neither
        // credited as a relevant technical field nor flagged. Answer it EXACTLY ONCE against
        // the candidate's education so a degree line is never dropped again.
        const { matching: degreeReconciled, result: degreeResult } = applyDegreeReconcile(guardedMatching, {
            hardRequirements: jdExtraction.hardRequirements,
            softRequirements: jdExtraction.softRequirements,
            education: educationEntries,
        });
        if (degreeResult) {
            log.info({
                pipelineRunId: env.pipelineRunId,
                requirement: degreeResult.requirementSkill,
                outcome: degreeOutcome(degreeResult),
            }, 'education_degree_reconciled');
        }

        // Years-gap enforcement (deterministic): when the JD's experience bar is a hard,
        // disqualifying requirement the candidate misses, the matcher (Haiku) may still rate
        // STRONG FIT with 0 gaps and "exceeds all hard requirements" — and a re-run of the SAME
        // JD then correctly rates REACH. Force the gap + cap the rating so the verdict (and the
        // downstream résumé structure it drives) is stable and honest run-to-run.
        const { matching: yearsReconciled, applied: yearsGapApplied } = applyYearsGapReconcile(degreeReconciled, yearsGap);
        if (yearsGapApplied) {
            log.info({
                pipelineRunId: env.pipelineRunId,
                relevantYears: yearsGap?.relevantYears,
                requiredYears: yearsGap?.requiredYears,
                cappedFitRating: yearsReconciled.overallFitRating,
            }, 'years_gap_enforced_disqualifying_experience_bar');
        }
        const { matching: correctedMatching, stats: correctiveStats } = await runCorrectiveRetrievalPass({
            matching: yearsReconciled, pool, userId: env.userId, pipelineRunId: env.pipelineRunId,
            pipelineContext: ctx, retrievalPrefilter,
        });
        // One gap row per real-world skill: the matcher can emit the same
        // requirement several ways (observed live: 'PHP/Hack' + 'PHP' + 'Hack').
        const guardedResearch = {
            ...research,
            data: {
                ...correctedMatching,
                gaps: dedupeSkillGaps(correctedMatching.gaps, aliasToCanonical, (d) =>
                    log.info({ pipelineRunId: env.pipelineRunId, ...d }, 'skill_gaps_deduped')),
            },
        };

        // Assemble StrategistResearchResult from jdExtraction (JdSignal) + guarded matching.
        // Build the Skill Evidence Ledger deterministically here — it's a pure function of the
        // JD tool list and the matching result, so it belongs in the pipeline orchestrator, not the agent.
        // Canonical JD skill list — the single authoritative "what the JD needs",
        // derived once from the jd-extractor signal. The ledger + ATS coverage (and,
        // in the centralisation refactor, the matcher) all key off this same list so
        // their counts reconcile instead of diverging per LLM re-read.
        const ledgerTools = canonicalJdSkills(jdExtraction);
        const baseLedger = buildSkillEvidenceLedger(ledgerTools, guardedResearch.data, { techGroups, techAliasMap });

        // Attach STRUCTURED code-file evidence: the actual code files using each skill's
        // technology (technology_evidence), not cosine-nearest prose/lexical matches. A
        // soft skill (e.g. "complex technical communication") resolves to no code canonical
        // → keeps its honest career grounding. GAP entries untouched. Pure + deterministic
        // (no I/O), so it is called directly — it never reaches out and cannot block.
        // Tag each row's source lane(s) — repo (standalone code) / project (a
        // documented project or its repos) / career (résumé). Runs on the
        // PRE-strip ledger so lanes classify the matcher's ORIGINAL citations:
        // attachCodeEvidence strips display files from conceptual skills, and
        // classifying afterwards left almost every entry lane-less (a live run
        // tallied 3 repo / 0 project / 0 career over 34 entries). Deterministic
        // + fail-open: an empty lane index simply yields no sourceLanes.
        const careerTerms = careerEntries.flatMap((e) => [e.company, e.title]).filter(Boolean);
        const lanedBase = attachSourceLanes(baseLedger, {
            projectNames: projectLaneIndex.projectNames,
            careerTerms,
        });
        const ledgerWithCode = attachCodeEvidence(lanedBase, { canonicalToFiles: canonicalToCodeFiles, aliasToCanonical });
        // Entries that only GAINED files in the code pass earn the repo lane.
        const lanedLedger = mergeRepoLane(ledgerWithCode);

        // Join the run's own retrieved KB passages onto each entry — the
        // "how was this verified" audit trail (source + cosine/rerank +
        // snippet) the evidence panel renders. Deterministic; gap entries
        // untouched; entries with no matching passage stay unannotated.
        const kbPassages = parseKbPassages(guardedResearch.data.kbContext, KB_CONTEXT_SEPARATOR);
        const skillEvidenceLedger = attachPassageProvenance(lanedLedger, kbPassages);

        const researchData: StrategistResearchResult = {
            ...jdExtraction,
            targetCompany: ctx.targetCompany,
            ...guardedResearch.data,
            skillEvidenceLedger,
        };

        // Evidence provenance + per-repo quality + repo profiles (observability, fail-open).
        await recordRunProvenance({
            pool, env, researchData, matching: guardedMatching,
            demotions, contradictions, codeTechByRepo, repoProfiles,
        });

        await updatePipelineRun(pool, env.pipelineRunId, 'analysing');

        // GROUNDED METRICS block: deterministic case-study ledger + the matcher's
        // verbatim KB pass-through. NEVER shown to the writer — feeding it there
        // tripled extended thinking (13.9K -> 37-56K output tokens, 4 -> 12-17 min,
        // measured 2026-07-08 across personas v6-v8) and correlated with WORSE
        // composition. It feeds the post-writer Haiku weave + allowed-number sets.
        const groundedMetricsBlock = composeMetricsBlock(metricsLedgerBlock, researchData.quantifiedEvidence);

        // ATS target selection + the projects-agent evidence pool -- pulled up
        // from their old post-writer positions so batch 1 (below) has them
        // ready before it starts. Pure/fail-open reads of data already in
        // scope (ledger, jdExtraction), except projectAgentInputs, which is
        // one more fail-open DB read (a transient error degrades to an empty
        // pool -> projects[] skeleton, never fails the run).
        const experienceAtsTargets = selectExperienceAtsTargets(skillEvidenceLedger, jdExtraction, 6);
        const summaryAtsTargets = selectSummaryAtsTargets(skillEvidenceLedger, { hardRequirements: jdExtraction.hardRequirements });
        const projectAgentInputs = await loadProjectAgentInputs(pool, env.userId, researchData.verifiedMatches)
            .catch((err: unknown) => {
                log.warn({ pipelineRunId: env.pipelineRunId, err: err instanceof Error ? err.message : String(err) }, 'project_agent_inputs_load_failed_fail_open');
                return { pool: [], unresolvedRepos: [] };
            });

        // -- BATCH 1: analysis + experience + projects + skills, concurrent --
        // (see runBatch1Agents's doc comment for the concurrency-safety proof)
        const analysisInput: AnalysisMessageInput = {
            research: researchData,
            codeStack: codeStackContext,
            yearsGapFraming: framingDirective(yearsGap) ?? '',
            profileIntelligence: profileIntelligenceBlock,
        };
        const skillsInput: SkillsMessageInput = {
            jd: jdExtraction,
            verifiedMatches: researchData.verifiedMatches,
            partialMatches: researchData.partialMatches,
        };
        const batch1 = await stageSeconds(pipelineStageSeconds, 'batch1', () => runBatch1Agents({
            ctx, skeleton: tailoredResumeData, analysisInput, researchData, careerEntries,
            experienceAtsTargets, groundedMetricsBlock, codeStackContext, projectAgentInputs, skillsInput,
            skillEvidenceLedger, jdExtraction, pipelineRunId: env.pipelineRunId,
        }));
        const { analysis, experienceAgentDiag, projectsAgentDiag, skillsAgentDiag } = batch1;
        recordBatch1Observability(batch1, { pipelineRunId: env.pipelineRunId, applicationId: env.applicationId });

        await updatePipelineRun(pool, env.pipelineRunId, 'persisting');

        // ── Grounding verification (block mode, fail-open) ─────────────────
        // Run after analysis is produced and KB context is available, before
        // any persistence so the verified (or fallback) text is what is stored.
        // Skip entirely when the KB returned no passages — block mode would
        // replace a perfectly good analysis with a one-line fallback.
        const contextChunks = (research.data.kbContext ?? '')
            .split(KB_CONTEXT_SEPARATOR)
            .filter((s: string) => s.trim().length > 0);
        let finalAnalysis = analysis.data.analysisXml;
        // Default non-NOT_GROUNDED → skipped (no verify) and verifier-threw
        // (fail-open) paths remain cacheable; only an explicit NOT_GROUNDED
        // fallback substitution must NOT be cached.
        let groundingStatus = 'GROUNDED';
        if (contextChunks.length > 0) {
            try {
                // The resume JSON + cover letter have dedicated guards — strip
                // them so the verifier judges only the analysis (smaller input,
                // and resume phrasing can no longer trigger a false
                // NOT_GROUNDED that block-replaces the whole analysis).
                const g = await groundingVerifier.verify({
                    query: `${env.targetRole ?? ''} ${env.targetCompany ?? ''}`.trim(),
                    contextChunks,
                    answer: stripDocumentSections(analysis.data.analysisXml),
                }, { pool, userId: env.userId });
                groundingStatus = g.status;
                finalAnalysis = resolveVerifiedAnalysis(analysis.data.analysisXml, g);
            } catch (e) {
                log.warn({
                    pipelineRunId: env.pipelineRunId,
                    error: (e as Error).message,
                }, 'Grounding verifier failed — keeping original analysis');
                strategistRuns.inc({ operation: 'analyse', outcome: 'grounding_error' });
            }
        } else {
            log.info({
                pipelineRunId: env.pipelineRunId,
            }, 'Grounding verification skipped — no KB context passages');
            strategistRuns.inc({ operation: 'analyse', outcome: 'grounding_skipped_no_context' });
        }

        // -- Reconcile: validate + refuse-empty (resume-reconciler.ts) -----
        // sectionOrder: see analysisSectionOrder's doc comment for why this is
        // always undefined, not a regression from the pre-split writer.
        // scrubInstructionLeaks (the pre-split writer's instruction-leak
        // scrub) is INTENTIONALLY gone: it stripped numbers that appeared in
        // the WRITER's persona text but nowhere in its evidence -- a class of
        // leak specific to that one giant persona. Every section agent now
        // has its OWN small, dedicated persona (none of them is
        // STRATEGIST_PERSONA_SYSTEM_PROMPT), so a leak from THAT specific
        // persona text cannot occur in their output; there is nothing left
        // for this pass to scrub.
        // tailoredResumeData is StructuredResumeData | null only because
        // reconcileRosterAgainstCareer's signature is shared with the
        // (genuinely nullable) post-writer call site it used to serve;
        // buildSkeletonResume above always returns a real object, so this is
        // a real invariant, not a cast of convenience -- throw loudly if it
        // is ever violated rather than silently coercing null through the
        // reconciler (which requires a non-null resume).
        if (!tailoredResumeData) {
            throw new Error('run-pipeline: skeleton resume was unexpectedly null before reconcile');
        }
        const resume: StructuredResumeData = await stageSeconds(pipelineStageSeconds, 'reconcile', async () => reconcileResumeSections(
            tailoredResumeData,
            analysisSectionOrder(analysis.data),
            {
                experience: () => verbatimExperienceFallback(careerEntries),
                projects:   () => deterministicProjects(projectAgentInputs.pool, experienceAtsTargets),
                skills:     () => deterministicSkills(skillEvidenceLedger, jdExtraction),
            },
            env.pipelineRunId,
        ));

        // -- BATCH 2: summary + cover letter, concurrent -- both read `resume` --
        const coverLetterInput: CoverLetterMessageInput | null = (ctx.includeCoverLetter ?? true) ? {
            targetRole:          researchData.targetRole,
            targetCompany:       researchData.targetCompany,
            companyProblem:      jdExtraction.companyProblem,
            achievementEvidence: achievementEvidenceBlock,
            candidateContact:    candidateContactBlock,
            yearsGapFraming:     framingDirective(yearsGap) ?? '',
            profileIntelligence: profileIntelligenceBlock,
            resumeBody:          resume,
        } : null;
        const batch2 = await stageSeconds(pipelineStageSeconds, 'batch2', () => runBatch2Agents({
            ctx, resume, researchData, profileIntelligenceBlock, yearsGap, achievementEvidenceBlock,
            summaryAtsTargets, coverLetterInput, pipelineRunId: env.pipelineRunId,
        }));
        const { summaryAtsDiag } = batch2;
        // Summary-ATS observability: Loki event stream + bounded Prometheus outcome/coverage
        // metrics. summaryAtsDiag itself is folded into the metadata.analysis write below
        // (pipeline_runs.metadata.analysis.summaryAts) rather than a second
        // updatePipelineRunMetadata call -- that call's top-level `analysis` key is a
        // shallow-merge (jsonb `||`) and a second call would clobber the analysis object
        // written later in this run. No traceId is in scope in this pipeline (only
        // run-clustering.ts / run-case-study.ts thread one through) -- null here is correct,
        // not a placeholder.
        if (summaryAtsDiag) {
            logSummaryAtsEvents(log, { pipelineRunId: env.pipelineRunId, applicationId: env.applicationId, traceId: null }, summaryAtsDiag);
            const { outcome, reason } = summaryAtsOutcome(summaryAtsDiag);
            summaryAtsOutcomeMetric.inc({ outcome, reason });
            // Only a run that actually scored real targets contributes a coverage
            // sample -- no-target runs and fallback runs (both report covered 0
            // without a genuine measurement) would otherwise dilute the histogram.
            if (summaryAtsDiag.coverageBefore.targets > 0 && !summaryAtsDiag.fallback.fired) {
                summaryAtsCoverageMetric.observe(summaryAtsDiag.coverageBefore.covered);
            }
        }
        recordCoverLetterAgentObservability(batch2.coverLetterAgentResult, { pipelineRunId: env.pipelineRunId, applicationId: env.applicationId });

        const archetype = analysis.data.archetypeSelection?.selectedArchetype ?? null;

        // -- Guards stage (cover-letter guard + relocation + resume guard) --
        const hasYearsBar = jdHasYearsBar(yearsGap);
        const letterFraming = tenureFramingFor(yearsGap);
        const archetypeId = analysis.data.archetypeSelection?.archetypeId ?? 0;
        const archetypeSkillLead = archetypeId === 7 ? 'Support & Troubleshooting' : '';
        const resumeGuardCtx: ResumeGuardCtx = {
            targetRole:        researchData.targetRole,
            leadIdentity:      analysis.data.archetypeSelection?.leadIdentity ?? '',
            verifiedEducation: (educationEntries ?? []).map((e) => e.degree),
            archetypeSkillLead,
            companyProblem:    jdExtraction.companyProblem,
            targetCompany:     researchData.targetCompany,
            projectPitches:    projectLaneIndex.projectPitches,
            jdRequiredSkills:  jdExtraction.requiredSkills,
            verifiedCertifications: toVerifiedCerts(certificationEntries),
            verifiedEmployers: toVerifiedEmployers(careerEntries),
        };
        const guardsResult = await stageSeconds(pipelineStageSeconds, 'guards', () => runGuardsStage({
            coverLetterCandidate: batch2.coverLetter,
            targetRole:           researchData.targetRole,
            leadIdentity:         analysis.data.archetypeSelection?.leadIdentity ?? '',
            letterFraming,
            coverLetterNarrative: buildCoverLetterNarrative(jdExtraction, projectLaneIndex.projectPitches, resume, hasYearsBar),
            resume,
            resumeGuardCtx,
            projectResumeBullets,
            violationLog,
        }));
        const finalCoverLetter = guardsResult.finalCoverLetter;

        // Grounding for the expand direction + the allowed-number set that
        // bounds ANY pass that can add content (expand, surface-keywords).
        // VERBATIM sources only (F2) — researchData.verifiedMatches[].sourceCitation
        // is the matcher's free-text PARAPHRASE of where a skill is demonstrated,
        // not verbatim KB text; folding it in let a paraphrased number (e.g. "cut
        // deploy time 40%") launder into the allowed set and surface in a bullet
        // as if verified. See grounding-facts.ts and its F2 regression test.
        const budgetGroundingFacts = buildGroundingFacts([
            experienceFactsBlock,
            projectEvidenceBlock,
            groundedMetricsBlock,
            // Server-computed years figure: without it the allowed-number set
            // has no years value and the stripper deletes "N years" from the
            // summary mid-sentence (observed live on run a428bdf4).
            formatVerifiedYearsFact(careerEntries),
        ]);

        // JD-priority context for length enforcement — required skills + the
        // company problem decide what survives a condense (JD-relevant first).
        const jdPriority: JdPriorityContext = {
            requiredSkills:   jdExtraction.requiredSkills,
            companyProblem:   jdExtraction.companyProblem,
            responsibilities: jdExtraction.responsibilities,
        };

        // -- Length stage (migration reframe + budget + metric weave + revalidate) --
        let finalResume: StructuredResumeData = await stageSeconds(pipelineStageSeconds, 'length', () => runLengthStage({
            resume: guardsResult.resume,
            baseline: resume,
            projectHighlightsSnapshot: guardsResult.relocatedSnapshot,
            resumeGuardCtx, jdPriority, budgetGroundingFacts, groundedMetricsBlock,
            targetRole: researchData.targetRole,
            requiredSkills: jdExtraction.requiredSkills,
            succeedsEdges, codeTechByRepo, aliasToCanonical,
            violationLog,
            pipelineRunId: env.pipelineRunId,
        }));

        // Resume-builder persist (Option A): persist the guarded resume to PG.
        const persisted = await stageSeconds(pipelineStageSeconds, 'persist', () => persistTailoredResume(pool, {
            applicationId:  env.applicationId,
            userId:         env.userId,
            pipelineId:     env.pipelineId,
            targetRole:     env.targetRole,
            archetype,
            tailoredResume: finalResume,
        }));

        // ── ATS render + parse-back QA (fail-open pipeline, fail-closed claim) ─
        // Renders the AI-authored resume to a text-selectable PDF, proves it
        // parses, and stores the canonical PDF + check. Delegated to a helper
        // that never throws (errors → 'unverified', never 'passed').
        let finalAts: AtsCheckResult | null = null;
        if (persisted) {
            const atsGateOut = await stageSeconds(pipelineStageSeconds, 'ats_gate', () => runAtsGateStage({
                pool,
                env: { applicationId: env.applicationId, userId: env.userId, pipelineId: env.pipelineId, targetRole: env.targetRole, pipelineRunId: env.pipelineRunId },
                researchData, jdExtraction, familyVocab, techGroups, techAliasMap, skillEvidenceLedger,
                resumeGuardCtx, jdPriority, experienceFactsBlock, projectEvidenceBlock,
                baseline: resume,
                projectHighlightsSnapshot: guardsResult.relocatedSnapshot,
                violationLog,
                persistedResumeId: persisted.resumeId,
                resume: finalResume,
                archetype,
            }));
            finalResume = atsGateOut.finalResume;
            finalAts = atsGateOut.finalAts;
        }

        // ── Resume prose-quality (stop-slop, flag mode, fail-open) ─────────
        // Lint the generated resume + cover-letter prose for AI-tell language.
        // Pure observability — never alters the persisted resume, never throws.
        await lintResumeProse(pool, env, finalResume, finalCoverLetter);

        // ── Path-grounding check (advisory, fail-open) ────────────────────
        // Flag file-path citations in the final analysis that don't exist in
        // the user's ingested document_embeddings. Runs on finalAnalysis so it
        // reflects whatever text will actually be persisted/served.
        const pathGrounding = await verifyAnalysisPaths(
            pool, env.userId, finalAnalysis, env.pipelineRunId,
        );

        // ── Gap-cause classification (advisory, fail-open) ────────────────
        // Split every research gap into kb_present_not_retrieved (evidence
        // exists, retrieval missed it → retrieval bug lead) vs kb_no_evidence
        // (nothing in the KB → user-facing "document this" signal). Persisted
        // on the gap entries; aggregated as a Prometheus counter for Grafana.
        const gapsWithCauses = await annotateGapCauses(
            pool, env.userId, researchData.gaps, (cause) => gapCauseMetric.inc({ cause }),
        ).catch(() => researchData.gaps);

        // Stash both outputs on pipeline_runs.metadata so the admin-api detail
        // endpoint can serve research fields (fitSummary, matches, gaps, etc.)
        // and a downstream coach K8s Job can re-hydrate without re-running.
        // analysisXml is replaced by finalAnalysis (grounded or original on fail-open).
        // pathGrounding.ungrounded lets the UI warn on hallucinated source paths.
        // atsCheck is stashed here as well as on resumes.ats_check_json so the
        // value is never lost if the RLS-scoped resumes write fails — admin-api
        // falls back to metadata.analysis.atsCheck.
        // metadata.guard answers "which violations fired, at which stage?" per
        // run — the counters alone die with the Job pod. One structured log
        // line makes the same answer greppable in Loki.
        const guardMeta = violationLog.toMetadata();
        if (guardMeta) {
            log.info({ pipelineRunId: env.pipelineRunId, guardTotal: guardMeta.total, guardViolations: guardMeta.violations }, 'guard_violations_recorded');
        }
        await updatePipelineRunMetadata(pool, env.pipelineRunId, {
            analysis:     { ...analysis.data, tailoredResumeData: finalResume, coverLetter: finalCoverLetter, analysisXml: finalAnalysis, pathGrounding, atsCheck: finalAts, yearsGap, summaryAts: summaryAtsDiag, experienceAgent: experienceAgentDiag, projectsAgent: projectsAgentDiag, skillsAgent: skillsAgentDiag, coverLetterAgent: coverLetterAgentOutcome(batch2.coverLetterAgentResult), analysisAgent: analysisAgentSummary(analysis.data) },
            research:     { ...researchData, gaps: gapsWithCauses, correctiveRetrieval: correctiveStats },
            jdExtraction,
            guard:   guardMeta,
            // LLM-agent cost (extraction + research + analysis + grounding); excludes embeddings/rerank.
            tokens:  ctx.cumulativeTokens,
            costUsd: ctx.cumulativeCostUsd,
        });

        // Store in the semantic cache (fire-and-forget, fail-open). Skip only
        // when grounding explicitly substituted the one-line fallback — a
        // skipped/fail-open verify keeps groundingStatus non-NOT_GROUNDED and
        // is therefore cacheable. The cache key is the PII-scrubbed JD.
        if (groundingStatus !== 'NOT_GROUNDED') {
            void semanticCache.put({
                scope:     cacheScope,
                kbTag:     cacheTag,
                queryText: jdForCache,
                response:  {
                    // analysis.data.tailoredResumeData AND .coverLetter are always
                    // null post-split (the analysis agent authors neither -- see
                    // analysis-agent.ts); explicitly override BOTH with the fully
                    // guarded final artefacts so a later cache HIT (~L1049-1075,
                    // replays this blob as-is) persists the guarded resume and the
                    // guarded letter, not nulls (final-review MEDIUM: the letter
                    // was silently dropped on new-shape cache hits).
                    analysis: { ...analysis.data, analysisXml: finalAnalysis, tailoredResumeData: finalResume, coverLetter: finalCoverLetter },
                    research: researchData,
                },
            }).catch(() => { /* fail-open — cache write must never break the run */ });
        }

        await updateJobApplicationStatus(pool, env.applicationId, 'analysis-ready');
        await updatePipelineRun(pool, env.pipelineRunId, 'complete');
        outcome = 'success';

        log.info({
            pipelineRunId: env.pipelineRunId,
            applicationId: env.applicationId,
            resumeId:      persisted?.resumeId ?? null,
        }, 'strategist_pipeline_complete');
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // error_message surfaces to the client via GET /runs/:id, so redact infra
        // identifiers (hosts/ARNs/file paths/etc.) before persisting — a raw DB /
        // AWS SDK / Zod message would leak internals (security). The FULL detail is
        // kept in the structured log below (operator-only) and referenced by the
        // SNS failure alert via pipelineRunId.
        const clientMessage = outputSanitiser.sanitise(message).slice(0, 500);
        await updatePipelineRun(pool, env.pipelineRunId, 'failed', clientMessage)
            .catch(() => { /* swallow — already failing */ });
        await updateJobApplicationStatus(pool, env.applicationId, 'failed')
            .catch(() => { /* swallow — already failing */ });
        log.error({
            pipelineRunId: env.pipelineRunId,
            applicationId: env.applicationId,
            err: message,
        }, 'strategist_pipeline_failed');
        throw err;
    } finally {
        await closePool();
        const duration = Number(process.hrtime.bigint() - start) / 1e9;
        strategistRuns.inc({ operation: 'analyse', outcome });
        strategistDuration.observe({ operation: 'analyse', outcome }, duration);
        await pushFinalMetrics(obs.registry, 'job-strategist', env.pipelineRunId);
        await obs.shutdown();
    }
}

// Only auto-execute when run as the K8s Job entrypoint, not when imported by tests.
if (require.main === module) {
    // Exit EXPLICITLY on success too. main() finishes its work and closes the pg
    // pool, but module-scope handles (S3Client, PgSemanticCache, fire-and-forget
    // promises) keep the event loop alive, so the process would otherwise hang —
    // leaving the K8s Job Running 0/1 until activeDeadlineSeconds force-kills it
    // (~30min) and burning a node slice every run. process.exit(0) ends it cleanly.
    main().then(
        () => process.exit(0),
        () => process.exit(1),
    );
}
