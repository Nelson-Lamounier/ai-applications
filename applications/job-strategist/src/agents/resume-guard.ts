/**
 * @format
 * Resume guard — facade + orchestrators.
 *
 * The rule families live in guards/ (one module per concern):
 *   - guards/types.ts          shared interfaces (ResumeViolation, ResumeGuardCtx, …)
 *   - guards/text.ts           tokenisers / name variants / sentence split
 *   - guards/summary-rules.ts  summary inventory, echo, bridge, attribution
 *   - guards/roster.ts         experience-roster invariant
 *   - guards/claims-rules.ts   cert years, compliance, prohibited/scoped claims
 *   - guards/fidelity-rules.ts experience/pitch/JD-echo grounding fidelity
 *   - guards/rewrite.ts        the bounded Haiku repair pass
 *
 * This file keeps the three orchestrators (validateResume, guardResume,
 * revalidateResumeContent) and re-exports every rule so existing consumers
 * (run-pipeline, ats/length-budget, tests) keep importing from
 * './resume-guard.js' unchanged. The monolith this replaces had grown past
 * 1,100 lines and its rules repeatedly slipped during review.
 */
import type { StructuredResumeData } from '@bedrock/shared';
import type { ResumeViolation, ResumeGuardCtx } from './guards/types.js';
import {
    TITLE_NOUNS, namesGap, leadClusterTokens, findMisplacedSelectedWork,
    checkSummaryInventory, checkProjectInventory, checkSummaryEcho,
    checkProblemBridge, checkSummaryAttribution,
    stripJobDescribingSentences, stripIdentityProblemClause,
} from './guards/summary-rules.js';
import {
    enforceCertYears, enforceProhibitedClaims, enforceScopedClaims,
    dropKeyAchievementsSection, stripEmDashes,
    checkComplianceOverclaim, checkMetricStuffedBullets,
} from './guards/claims-rules.js';
import { preserveExperienceRoster } from './guards/roster.js';
import {
    checkProjectPitchAlignment, checkBulletJdEcho, checkExperienceFidelity,
} from './guards/fidelity-rules.js';
import { rewriteResume } from './guards/rewrite.js';

// Re-export the full rule surface — consumers import from './resume-guard.js'.
export type { ResumeViolation, VerifiedEmployer, ResumeGuardCtx } from './guards/types.js';
export {
    summarySharedNumbers, summaryEchoSentences, summaryConflationSentences,
    identityProblemPhrases, jobDescribingSentences, targetCompanySentences,
    stripJobDescribingSentences, stripIdentityProblemClause,
} from './guards/summary-rules.js';
export { preserveExperienceRoster } from './guards/roster.js';
export {
    enforceCertYears, enforceProhibitedClaims, enforceScopedClaims,
    dropKeyAchievementsSection, stripEmDashes,
    PROHIBITED_CLAIMS, SCOPED_CLAIMS,
} from './guards/claims-rules.js';
export type { ProhibitedClaim, ScopedClaim } from './guards/claims-rules.js';
export {
    checkProjectPitchAlignment, checkBulletJdEcho, checkExperienceFidelity,
} from './guards/fidelity-rules.js';
export { rewriteResume, RESUME_REWRITE_PROMPT_META } from './guards/rewrite.js';

/** profile.title must be a capability headline, never a job-title claim. */
function checkHeadline(out: ResumeViolation[], resume: StructuredResumeData): void {
    const title = resume.profile.title.trim();
    if (!title) return;
    const hasSeparator = /[·—|]/.test(title);
    const employmentTitles = new Set(resume.experience.map((e) => e.title.toLowerCase().trim()));
    const leadSeg = title.split(/[·—|]/)[0].trim().toLowerCase();
    const hasTitleNoun = leadSeg.split(/\s+/).some((w) => TITLE_NOUNS.has(w));
    if (!hasSeparator || employmentTitles.has(title.toLowerCase()) || hasTitleNoun) {
        out.push({ code: 'headline_is_title', detail: `profile.title "${title}" reads as a job-title claim — it must be a descriptive domain/capability headline with NO job-title noun (Engineer, Associate, Analyst, Manager, Developer, Specialist, Lead, Architect…).` });
    }
}

/** Summary opener must lead the archetype cluster and never concede the gap. */
function checkSummaryOpener(out: ResumeViolation[], resume: StructuredResumeData, ctx: ResumeGuardCtx): void {
    const summary = resume.summary.trim();
    const firstSentence = summary.split(/(?<=[.!?])\s/)[0]?.toLowerCase() ?? '';
    const tokens = leadClusterTokens(ctx.leadIdentity);
    if (summary && tokens.length > 0 && !tokens.some((t) => firstSentence.includes(t))) {
        out.push({ code: 'summary_wrong_cluster', detail: 'Summary opener does not lead with the archetype lead-identity differentiator.' });
    }
    if (namesGap(summary)) {
        out.push({ code: 'summary_names_gap', detail: 'Summary names/concedes the experience gap.' });
    }
}

/** Every education degree must appear in the verified facts. */
function checkEducation(out: ResumeViolation[], resume: StructuredResumeData, ctx: ResumeGuardCtx): void {
    const verifiedLower = new Set(ctx.verifiedEducation.map((v) => v.toLowerCase()));
    for (const ed of resume.education) {
        const deg = ed.degree.toLowerCase();
        if (deg && !Array.from(verifiedLower).some((v) => v.includes(deg) || deg.includes(v))) {
            out.push({ code: 'education_mismatch', detail: `Education "${ed.degree}" not in the verified facts.` });
            break;
        }
    }
}

/** The archetype's lead skill group must come first. */
function checkSkillsLead(out: ResumeViolation[], resume: StructuredResumeData, ctx: ResumeGuardCtx): void {
    if (!ctx.archetypeSkillLead) return;
    const firstCat = (resume.skills[0]?.category ?? '').toLowerCase();
    if (firstCat && firstCat !== ctx.archetypeSkillLead.toLowerCase()) {
        out.push({ code: 'skills_lead_mismatch', detail: `First skill group "${resume.skills[0]?.category}" is not the archetype lead "${ctx.archetypeSkillLead}".` });
    }
}

export function validateResume(resume: StructuredResumeData, ctx: ResumeGuardCtx): ResumeViolation[] {
    const out: ResumeViolation[] = [];

    checkHeadline(out, resume);
    checkSummaryOpener(out, resume, ctx);
    checkEducation(out, resume, ctx);
    checkSkillsLead(out, resume, ctx);

    checkSummaryInventory(out, resume);
    checkProjectInventory(out, resume);
    checkSummaryEcho(out, resume);
    checkProblemBridge(out, resume, ctx.companyProblem);
    checkSummaryAttribution(out, resume, ctx);
    checkComplianceOverclaim(out, resume);
    checkMetricStuffedBullets(out, resume);

    const misplaced = findMisplacedSelectedWork(resume);
    if (misplaced) {
        out.push({ code: 'selected_work_misplaced', detail: `"Selected work"/GitHub links appear under the support/customer role "${misplaced}" — they must sit under a builder/engineering role (e.g. Freelance / Cloud & DevOps), or a Projects section.` });
    }

    return out;
}

/** All deterministic content checks shared by revalidation's two sweeps. */
function collectContentViolations(resume: StructuredResumeData, ctx: ResumeGuardCtx): ResumeViolation[] {
    const out: ResumeViolation[] = [];
    checkSummaryInventory(out, resume);
    checkProjectInventory(out, resume);
    checkSummaryEcho(out, resume);
    checkProblemBridge(out, resume, ctx.companyProblem);
    checkSummaryAttribution(out, resume, ctx);
    checkComplianceOverclaim(out, resume);
    checkMetricStuffedBullets(out, resume);
    // Pitch alignment must hold through the WHOLE chain: run 9216cf25's first
    // guard pass repaired both project pitches, then the condense pass cut
    // them ("non-JD content is cut FIRST") and both revalidations were blind
    // to the loss — stack-led descriptions shipped despite the repair.
    out.push(...checkProjectPitchAlignment(resume, ctx.projectPitches));
    return out;
}

/**
 * FINAL content re-validation — runs after the LAST mutating pass (migration
 * reframe, condense/expand, surface-keywords), because those passes were
 * observed reintroducing violations the early guard had already repaired
 * (the A/B run's project regained 5 bullet-shared numbers, and an unbridged
 * "Terraform" appeared in the summary). Deterministic checks + ONE bounded
 * repair; anything still violating after that is reported, never looped.
 */
export async function revalidateResumeContent(
    resume: StructuredResumeData,
    ctx: ResumeGuardCtx,
): Promise<{ resume: StructuredResumeData; violations: ResumeViolation[] }> {
    const prohibited = enforceProhibitedClaims(resume);
    const certs = enforceCertYears(prohibited.resume, ctx.verifiedCertifications ?? []);
    const scoped = enforceScopedClaims(certs.resume);
    let out = scoped.resume;
    const violations: ResumeViolation[] = [...prohibited.violations, ...certs.violations, ...scoped.violations];

    const inventory = collectContentViolations(out, ctx);
    const needsRepair = [
        ...inventory,
        ...violations.filter((v) => v.code === 'unbridged_transferable_claim'),
    ];
    if (needsRepair.length > 0) {
        violations.push(...inventory);
        const beforeRepair = out;
        out = await rewriteResume(out, needsRepair, ctx);
        out = preserveExperienceRoster(beforeRepair, out, (v) => violations.push(v));
        // Deterministic passes are idempotent — re-assert after the repair.
        out = enforceProhibitedClaims(out).resume;
        out = enforceCertYears(out, ctx.verifiedCertifications ?? []).resume;
        out = enforceScopedClaims(out).resume;
        const residual = collectContentViolations(out, ctx);
        if (residual.length > 0) {
            violations.push({ code: 'content_revalidation_residual', detail: `After one bounded repair, still violating: ${residual.map((r) => r.code).join(', ')}.` });
        }
    }
    // Deterministic backstops — a summary must never SHIP describing the job,
    // naming the target company, or wearing the companyProblem's phrasing as
    // identity. Prose-preserving repair got its one chance above.
    out = stripJobDescribingSentences(out, ctx, (v) => violations.push(v));
    out = stripIdentityProblemClause(out, ctx.companyProblem, (v) => violations.push(v));
    return { resume: stripEmDashes(out), violations };
}

/** Validate → rewrite on violation → deterministic scoped-claim + section passes → return. Never throws. */
export async function guardResume(
    resume: StructuredResumeData,
    ctx: ResumeGuardCtx,
): Promise<{ resume: StructuredResumeData; violations: ResumeViolation[] }> {
    const violations = validateResume(resume, ctx);
    violations.push(...checkExperienceFidelity(resume, ctx.verifiedEmployers));
    violations.push(...checkProjectPitchAlignment(resume, ctx.projectPitches));
    violations.push(...checkBulletJdEcho(resume, ctx.verifiedEmployers, `${ctx.targetRole ?? ''}: ${(ctx.jdRequiredSkills ?? []).join(', ')}`));
    let rewritten = violations.length === 0 ? resume : await rewriteResume(resume, violations, ctx);
    rewritten = preserveExperienceRoster(resume, rewritten, (v) => violations.push(v));
    const scoped = enforceScopedClaims(rewritten);
    violations.push(...scoped.violations);
    const sectioned = dropKeyAchievementsSection(scoped.resume);
    violations.push(...sectioned.violations);
    return { resume: stripEmDashes(sectioned.resume), violations };
}
