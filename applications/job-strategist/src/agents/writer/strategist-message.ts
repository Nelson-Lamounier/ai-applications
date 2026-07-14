/**
 * @format
 * Strategist user-message builder — one named section per context block.
 *
 * The writer's prompt is assembled from ~20 context sections (research brief,
 * requirements, evidence blocks, the closing directive, …). This module keeps
 * each section as its own small builder and lists them, in order, in
 * `STRATEGIST_MESSAGE_SECTIONS`. That array is the single place to:
 *   - tune ONE section without reading the others,
 *   - reorder sections, or
 *   - disable a section (comment out its entry).
 *
 * `buildStrategistMessage` just runs the pipeline, so its complexity is O(1)
 * regardless of how many sections exist. The output is byte-identical to the
 * previous inline builder — extraction only, no wording change.
 */
import type { StrategistPipelineContext, StrategistResearchResult } from '@bedrock/shared';
import { formatResumeForPrompt } from '../../services/resume-service.js';

/** Everything any section builder may read. Optional string blocks default to ''. */
export interface StrategistMessageInput {
    readonly research: StrategistResearchResult;
    readonly ctx: StrategistPipelineContext;
    readonly projectEvidence: string;
    readonly educationFacts: string;
    readonly experienceFacts: string;
    readonly roleEvidence: string;
    readonly yearsGapFraming: string;
    readonly codeStackContext: string;
    readonly achievementEvidence: string;
    readonly profileIntelligence?: string;
    readonly candidateContact?: string;
    readonly projectResumeBullets: string;
}

/** A prompt section: pushes its lines onto `out`, or no-ops when it has nothing to add. */
export interface StrategistMessageSection {
    readonly name: string;
    build(out: string[], m: StrategistMessageInput): void;
}

/**
 * Header for the Profile Intelligence section of the BODY's user message.
 * Until 2026-07-09 the profile block was concatenated into the project
 * case-studies section, whose preamble scopes usage to grounding bullets —
 * run 77e325ea shipped a summary whose S3 slot was a second rigor close while
 * the user's undersold differentiators sat unused inside the wrong wrapper.
 * That is why it is its own labelled section.
 *
 * Since the summary-agent split, the BODY no longer composes the resume
 * summary itself: the summary's S3 distinctive angle is composed by the
 * separate summary agent (summary-message.ts) from its OWN "## Profile
 * Intelligence" section — a different pin relationship (see
 * strategist-summary-persona.test.ts), not this header. NOTE: the body's
 * Profile Intelligence prompt wording below (this header, plus the
 * instructional text in buildProfileIntelligence) still tells the body's
 * model that this section is "the summary S3 distinctive-angle source" /
 * the "PRIMARY source for the summary's S3 distinctive angle". That wording
 * is stale relative to control flow but is left unchanged here: retuning it
 * is a prompt change requiring its own eval (CLAUDE.md §5) and is deferred
 * to that follow-up / a UI A-B, not a comment cleanup.
 */
export const PROFILE_INTELLIGENCE_HEADER =
    '### Profile Intelligence (code-grounded — the summary S3 distinctive-angle source)';

/**
 * Header for the per-user contact section — the persona's cover-letter signoff
 * and resume profile placeholders reference this section BY NAME. The persona
 * previously carried one user's literal contact details as the signoff
 * example (a multi-tenant identity leak for every other user).
 */
export const CANDIDATE_CONTACT_HEADER =
    '### Candidate Contact (VERBATIM source for the resume profile and cover-letter signoff)';

// =============================================================================
// SECTION BUILDERS (order-preserving; each guards itself and no-ops when empty)
// =============================================================================

/** Opening brief: role/company/seniority/fit. Always present. */
function buildResearchBrief(out: string[], { research }: StrategistMessageInput): void {
    out.push(
        '## Research Agent Brief',
        `Target Role: ${research.targetRole}`,
        `Target Company: ${research.targetCompany}`,
        `Seniority: ${research.seniority}`,
        `Domain: ${research.domain}`,
        `Overall Fit Rating: ${research.overallFitRating}`,
        `Fit Summary: ${research.fitSummary}`,
        '',
    );
}

/** The company problem — position the candidate as the answer. */
function buildCompanyProblem(out: string[], { research }: StrategistMessageInput): void {
    if (!research.companyProblem?.trim()) return;
    out.push(
        '### The Problem This Role Solves (position the candidate as the answer)',
        research.companyProblem.trim(),
        'Lead the summary + cover letter with how the candidate SOLVES this problem — using only verified/partial evidence below. Do not merely list matching keywords; show the candidate is the answer to what they are actually hiring for. Never invent capabilities to fit the problem.',
        '',
    );
}

/** Authoritative current code stack (doc-vs-code drift). */
function buildCodeStack(out: string[], { codeStackContext }: StrategistMessageInput): void {
    if (!codeStackContext.trim()) return;
    out.push(
        codeStackContext.trim(),
        'When writing experience bullets, present the CURRENT code-stack technology as current; if the candidate previously used a different technology for the same repo (per the docs), describe it in the PAST tense as a prior approach. Never state a superseded technology as the current implementation.',
        '',
    );
}

/** Role emphasis — weight the resume to the JD's dimension mix. */
function buildRoleEmphasis(out: string[], { research }: StrategistMessageInput): void {
    const dm = research.dimensionMix;
    if (!dm || !(dm.customerFacing > 0 || dm.technical > 0 || dm.aiMl > 0 || dm.supportOps > 0 || dm.monitoring > 0)) return;
    out.push(
        '### Role Emphasis (balance the resume to this mix)',
        `customer-facing ${dm.customerFacing}% · technical ${dm.technical}% · AI/ML ${dm.aiMl}% · support/ops ${dm.supportOps}% · monitoring ${dm.monitoring}%`,
        'Lead and weight the summary + experience emphasis to the DOMINANT dimension(s); do not over-index on a low-weight dimension. Never fabricate to fit — use only verified evidence.',
        '',
    );
}

/** Hard + soft + implicit requirements. */
function buildRequirements(out: string[], { research }: StrategistMessageInput): void {
    out.push('### Hard Requirements');
    for (const req of research.hardRequirements) {
        out.push(`- **${req.skill}**: ${req.context} ${req.disqualifying ? '⚠️ DISQUALIFYING' : ''}`);
    }

    out.push('', '### Soft Requirements');
    for (const req of research.softRequirements) {
        out.push(`- **${req.skill}**: ${req.context}`);
    }

    if (research.implicitRequirements.length > 0) {
        out.push('', '### Implicit Requirements');
        for (const req of research.implicitRequirements) {
            out.push(`- ${req}`);
        }
    }
}

/** Join a technology list, or the 'None specified' placeholder when empty. */
function techLine(values: readonly string[] | undefined): string {
    return (values ?? []).join(', ') || 'None specified';
}

/** Technology inventory (guarded against LLM output variations). */
function buildTechnologyInventory(out: string[], { research }: StrategistMessageInput): void {
    const techInv = research.technologyInventory;
    out.push(
        '', '### Technology Inventory',
        `Languages: ${techLine(techInv?.languages)}`,
        `Frameworks: ${techLine(techInv?.frameworks)}`,
        `Infrastructure: ${techLine(techInv?.infrastructure)}`,
        `Tools: ${techLine(techInv?.tools)}`,
        `Methodologies: ${techLine(techInv?.methodologies)}`,
    );
}

/** Verified / partial / gap matches from the research brief. */
function buildMatches(out: string[], { research }: StrategistMessageInput): void {
    const verifiedLines = research.verifiedMatches.map(
        (m) => `- **${m.skill}** [${m.depth}]: ${m.sourceCitation} (${m.recency})`,
    );
    out.push('', '### Verified Matches (Evidence-Backed)', ...verifiedLines);

    out.push('', '### Partial Matches (Transferable)');
    for (const partial of research.partialMatches) {
        out.push(
            `- **${partial.skill}**: ${partial.gapDescription}`,
            `  Foundation: ${partial.transferableFoundation}`,
            `  Framing: ${partial.framingSuggestion}`,
        );
    }

    out.push('', '### Gaps');
    for (const gap of research.gaps) {
        out.push(`- **${gap.skill}** [${gap.gapType}/${gap.impactSeverity}]: ${gap.disqualifyingAssessment}`);
    }
}

/** PATH B uploaded resume — FORMATTING reference only, content prohibited. */
function buildResumeData(out: string[], { research }: StrategistMessageInput): void {
    if (!research.resumeData) return;
    out.push(
        '', '### PATH B — Uploaded Resume (FORMATTING REFERENCE ONLY)',
        '',
        '⚠️  CONTENT PROHIBITION — NEVER VIOLATE:',
        'Do NOT copy, paraphrase, or derive any content from this document.',
        'PERMITTED: section ordering preference, header/contact block format only.',
        'PROHIBITED: any bullet, summary, skill list, or project description from this document.',
        'All resume content must be generated from the KB evidence in the research brief above.',
        'If this document\'s structure conflicts with the Phase 0 archetype ordering, the ARCHETYPE WINS.',
        'If a section appears here but has no KB evidence, leave it EMPTY — do not copy to fill.',
        '--- BEGIN FORMATTING REFERENCE ---',
        formatResumeForPrompt(research.resumeData),
        '--- END FORMATTING REFERENCE ---',
    );
}

/** Resume domain constraints (mandatory rules + gap boundaries). */
function buildResumeConstraints(out: string[], { research }: StrategistMessageInput): void {
    if (!research.resumeConstraints) return;
    out.push(
        '', '### Resume Domain Constraints (MANDATORY — Read Before Generating Bullets)',
        'These are NON-NEGOTIABLE rules and gap boundaries from the resume domain KB.',
        'Apply these constraints BEFORE and AFTER generating each project bullet and section',
        'you author (experience bullets are authored by a dedicated pass).',
        '--- BEGIN CONSTRAINTS ---',
        research.resumeConstraints,
        '--- END CONSTRAINTS ---',
    );
}

/** Verified experience — exact company/title/period, reproduced verbatim. */
function buildExperienceFacts(out: string[], { experienceFacts }: StrategistMessageInput): void {
    if (!experienceFacts) return;
    out.push(
        '', '### Verified Experience (FACTUAL — REPRODUCE TITLES VERBATIM)',
        'Each entry in the "experience" array of <tailored_resume_json> MUST use the exact',
        'company, job title, and period below. NEVER rename a role (e.g. do not relabel',
        '"Technical Customer Service Associate" as "Cloud Support Engineer"). Reposition only',
        'in the profile headline + summary. Emit highlights as an EMPTY array for every entry --',
        'a dedicated experience pass authors the bullets.',
        '--- BEGIN EXPERIENCE ---',
        experienceFacts,
        '--- END EXPERIENCE ---',
    );
}

/** Years-gap framing — lead the summary with this true relevant-experience line. */
function buildYearsGapFraming(out: string[], { yearsGapFraming }: StrategistMessageInput): void {
    if (!yearsGapFraming) return;
    out.push('', `YEARS GAP FRAMING (lead the summary with this true relevant-experience framing): ${yearsGapFraming}`);
}

/** Verified education — exact degree + institution, reproduced verbatim. */
function buildEducationFacts(out: string[], { educationFacts }: StrategistMessageInput): void {
    if (!educationFacts) return;
    out.push(
        '', '### Verified Education (FACTUAL — REPRODUCE VERBATIM)',
        'The "education" array of <tailored_resume_json> MUST use these exact degree names and',
        'institutions. Never invent, abbreviate, or substitute an institution. If a fact below',
        'conflicts with any constraint or template, THESE FACTS WIN.',
        '--- BEGIN EDUCATION ---',
        educationFacts,
        '--- END EDUCATION ---',
    );
}

/** Documented project case studies — citeable evidence for grounding bullets. */
function buildProjectEvidence(out: string[], { projectEvidence }: StrategistMessageInput): void {
    if (!projectEvidence) return;
    out.push(
        '', '### Documented Project Case Studies (CITEABLE EVIDENCE)',
        'These are the candidate\'s own documented projects. When a JD skill or achievement is',
        'demonstrated by a project\'s stack or decisions, you MAY ground the bullet in it and name',
        'the project (e.g. "… in <Project>"). Do NOT invent project facts beyond what is listed.',
        '--- BEGIN PROJECT CASE STUDIES ---',
        projectEvidence,
        '--- END PROJECT CASE STUDIES ---',
    );
}

/** Per-angle tailored bullets — the AUTHORITATIVE source for projects[].highlights. */
function buildProjectResumeBullets(out: string[], { projectResumeBullets }: StrategistMessageInput): void {
    if (!projectResumeBullets.trim()) return;
    out.push(
        '', '### Project Resume Bullets (SELECT projects[].highlights FROM THESE — quote-only, never invent)',
        'For EACH project you include in <tailored_resume_json> "projects", populate its',
        '"highlights" array by selecting the 3-6 bullets below that best answer THIS JD\'s named',
        'requirements. Copy them verbatim or trim for length — never add a fact not present here.',
        'Prefer bullets that surface a JD must-have skill. Match each bullet to its project by the',
        '"## <name>" heading. These bullets are PROJECT work: they go ONLY in "projects", NEVER as',
        'an Experience entry — do NOT invent a job title (e.g. "Solo SRE Engineer") or a "Project"',
        'period to host them. One "projects" entry per "## <name>" — never split one project in two.',
        '--- BEGIN PROJECT RESUME BULLETS ---',
        projectResumeBullets.trim(),
        '--- END PROJECT RESUME BULLETS ---',
    );
}

/** Profile Intelligence — positioning source, not bullet evidence. */
function buildProfileIntelligence(out: string[], { profileIntelligence }: StrategistMessageInput): void {
    if (!profileIntelligence?.trim()) return;
    out.push(
        '', PROFILE_INTELLIGENCE_HEADER,
        'Code-grounded synthesis of the candidate\'s OWN GitHub: code-demonstrated direction and',
        'seniority, UNDERSOLD strengths (what the code proves but the resume under-states), and',
        'unsupported resume claims to avoid leaning on. This is the PRIMARY source for the',
        'summary\'s S3 distinctive angle and for positioning choices. It is NOT project',
        'case-study evidence: cite projects from the case-studies section, not from here.',
        '--- BEGIN PROFILE INTELLIGENCE ---',
        profileIntelligence.trim(),
        '--- END PROFILE INTELLIGENCE ---',
    );
}

/** Per-user contact — VERBATIM source for profile + cover-letter signoff. */
function buildCandidateContact(out: string[], { candidateContact }: StrategistMessageInput): void {
    if (!candidateContact?.trim()) return;
    out.push('', CANDIDATE_CONTACT_HEADER, candidateContact.trim());
}

/** Achievement & impact evidence — cover-letter material. */
function buildAchievementEvidence(out: string[], { achievementEvidence }: StrategistMessageInput): void {
    if (!achievementEvidence) return;
    out.push(
        '',
        '### Achievement & Impact Evidence (use for the cover letter: lead with a challenge overcome; surface decision impacts relevant to the JD)',
        achievementEvidence,
    );
}

/** Role-ontology grounding block (target-role vocabulary). */
function buildRoleEvidence(out: string[], { roleEvidence }: StrategistMessageInput): void {
    if (!roleEvidence) return;
    out.push('', roleEvidence);
}

/** Interview-stage context + cover-letter directive + closing execute instruction. */
function buildClosing(out: string[], { ctx }: StrategistMessageInput): void {
    const shouldIncludeCoverLetter = ctx.includeCoverLetter ?? true;
    const coverLetterDirective = shouldIncludeCoverLetter
        ? 'Include a full cover letter in the <cover_letter> section.'
        : 'SKIP the cover letter — leave the <cover_letter> section as an empty CDATA block: <cover_letter><![CDATA[]]></cover_letter>';

    out.push(
        '', `### Current Interview Stage: ${ctx.interviewStage}`,
        '', coverLetterDirective,
        '', 'Execute Phases 1–4 of the analysis framework and return the complete XML output.',
    );
}

/**
 * The ordered prompt-section pipeline — THE place to tune, reorder, or disable
 * a single section. Each runs unconditionally; a section that has nothing to
 * contribute no-ops internally.
 */
export const STRATEGIST_MESSAGE_SECTIONS: readonly StrategistMessageSection[] = [
    { name: 'research-brief',        build: buildResearchBrief },
    { name: 'company-problem',       build: buildCompanyProblem },
    { name: 'code-stack',            build: buildCodeStack },
    { name: 'role-emphasis',         build: buildRoleEmphasis },
    { name: 'requirements',          build: buildRequirements },
    { name: 'technology-inventory',  build: buildTechnologyInventory },
    { name: 'matches',               build: buildMatches },
    { name: 'resume-data',           build: buildResumeData },
    { name: 'resume-constraints',    build: buildResumeConstraints },
    { name: 'experience-facts',      build: buildExperienceFacts },
    { name: 'years-gap-framing',     build: buildYearsGapFraming },
    { name: 'education-facts',       build: buildEducationFacts },
    { name: 'project-evidence',      build: buildProjectEvidence },
    { name: 'project-resume-bullets', build: buildProjectResumeBullets },
    { name: 'profile-intelligence',  build: buildProfileIntelligence },
    { name: 'candidate-contact',     build: buildCandidateContact },
    { name: 'achievement-evidence',  build: buildAchievementEvidence },
    { name: 'role-evidence',         build: buildRoleEvidence },
    { name: 'closing',               build: buildClosing },
];

/**
 * Build the user message for the Strategist Agent by running the section
 * pipeline. Positional signature kept for backward compatibility with the
 * existing caller + tests.
 */
export function buildStrategistMessage(
    research: StrategistResearchResult,
    ctx: StrategistPipelineContext,
    projectEvidence = '',
    educationFacts = '',
    experienceFacts = '',
    roleEvidence = '',
    yearsGapFraming = '',
    codeStackContext = '',
    achievementEvidence = '',
    profileIntelligence?: string,
    candidateContact?: string,
    projectResumeBullets = '',
): string {
    const m: StrategistMessageInput = {
        research, ctx, projectEvidence, educationFacts, experienceFacts, roleEvidence,
        yearsGapFraming, codeStackContext, achievementEvidence, profileIntelligence,
        candidateContact, projectResumeBullets,
    };
    const out: string[] = [];
    for (const section of STRATEGIST_MESSAGE_SECTIONS) section.build(out, m);
    return out.join('\n');
}
