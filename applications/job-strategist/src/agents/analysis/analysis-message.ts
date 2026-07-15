/**
 * @format
 * Strategist Analysis Agent user-message builder.
 *
 * MOVED from `agents/writer/strategist-message.ts` (Phase 5 PR-B Task 3): the
 * ANALYSIS-relevant subset of the writer's ~20-section prompt -- research
 * brief, company problem, code stack, role emphasis, requirements, technology
 * inventory, matches, resume constraints, years-gap framing, and profile
 * intelligence. Each builder's text is kept BYTE-IDENTICAL to its
 * strategist-message.ts original where the wording is already analysis
 * relevant; a builder whose original wording addressed resume/cover-letter
 * AUTHORING (bullet composition, "lead the summary with...") has that one
 * line reworded to analysis framing -- the change is called out in the
 * builder's own doc comment.
 *
 * NOT moved here (writer-only, feed VERBATIM facts into bullets this agent
 * never authors): resume-data, experience-facts, education-facts,
 * candidate-contact, achievement-evidence, role-evidence. Those stay in
 * strategist-message.ts until Task 8 deletes it.
 */
import type { StrategistResearchResult } from '@bedrock/shared';

/** Everything any analysis section builder may read. Optional blocks default to ''. */
export interface AnalysisMessageInput {
    readonly research: StrategistResearchResult;
    readonly codeStack: string;
    readonly yearsGapFraming: string;
    readonly profileIntelligence?: string;
}

/** An analysis-prompt section: pushes its lines onto `out`, or no-ops when it has nothing to add. */
export interface AnalysisMessageSection {
    readonly name: string;
    build(out: string[], m: AnalysisMessageInput): void;
}

/**
 * Header for the Profile Intelligence section of the ANALYSIS agent's user
 * message. Reworded from the writer's original header ("the summary S3
 * distinctive-angle source") -- since the summary-agent split, the summary
 * agent reads its OWN copy of this evidence (summary-message.ts); for the
 * analysis agent this block instead grounds Phase 0 (archetype/lead identity)
 * and Phase 3 (positioning narrative).
 */
export const ANALYSIS_PROFILE_INTELLIGENCE_HEADER =
    '### Profile Intelligence (code-grounded -- direction, seniority, and positioning signal)';

// =============================================================================
// SECTION BUILDERS (moved from strategist-message.ts; order-preserving)
// =============================================================================

/** Opening brief: role/company/seniority/fit. Always present. MOVED verbatim. */
function buildResearchBrief(out: string[], { research }: AnalysisMessageInput): void {
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

/**
 * The company problem -- position the candidate as the answer.
 *
 * STRIPPED: the original directive line read "Lead the summary + cover
 * letter with how the candidate SOLVES this problem" -- the analysis agent
 * authors neither. Reworded to point at the fit narrative + gap mitigations
 * it DOES author.
 */
function buildCompanyProblem(out: string[], { research }: AnalysisMessageInput): void {
    if (!research.companyProblem?.trim()) return;
    out.push(
        '### The Problem This Role Solves (position the candidate as the answer)',
        research.companyProblem.trim(),
        'Frame the fit narrative and gap mitigations around how the candidate SOLVES this problem -- using only verified/partial evidence below. Do not merely list matching keywords; show the candidate is the answer to what they are actually hiring for. Never invent capabilities to fit the problem.',
        '',
    );
}

/**
 * Authoritative current code stack (doc-vs-code drift).
 *
 * STRIPPED: the original directive line read "When writing experience
 * bullets, present the CURRENT code-stack technology as current" -- the
 * analysis agent authors no bullets. Reworded to the fit assessment and
 * gap-mitigation narrative it DOES author.
 */
function buildCodeStack(out: string[], { codeStack }: AnalysisMessageInput): void {
    if (!codeStack.trim()) return;
    out.push(
        codeStack.trim(),
        'When assessing fit and composing the gap-mitigation narrative, treat the CURRENT code-stack technology as current; if the candidate previously used a different technology for the same repo (per the docs), describe it as a prior approach. Never state a superseded technology as the current implementation.',
        '',
    );
}

/**
 * Role emphasis -- weight the analysis to the JD's dimension mix.
 *
 * STRIPPED: the original directive line read "Lead and weight the summary +
 * experience emphasis" -- the analysis agent authors neither. Reworded to
 * the fit narrative + positioning it DOES author.
 */
function buildRoleEmphasis(out: string[], { research }: AnalysisMessageInput): void {
    const dm = research.dimensionMix;
    if (!dm || !(dm.customerFacing > 0 || dm.technical > 0 || dm.aiMl > 0 || dm.supportOps > 0 || dm.monitoring > 0)) return;
    out.push(
        '### Role Emphasis (balance the analysis to this mix)',
        `customer-facing ${dm.customerFacing}% · technical ${dm.technical}% · AI/ML ${dm.aiMl}% · support/ops ${dm.supportOps}% · monitoring ${dm.monitoring}%`,
        'Lead and weight the fit narrative + positioning emphasis to the DOMINANT dimension(s); do not over-index on a low-weight dimension. Never fabricate to fit -- use only verified evidence.',
        '',
    );
}

/** Hard + soft + implicit requirements. MOVED verbatim. */
function buildRequirements(out: string[], { research }: AnalysisMessageInput): void {
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

/** Join a technology list, or the 'None specified' placeholder when empty. MOVED verbatim. */
function techLine(values: readonly string[] | undefined): string {
    return (values ?? []).join(', ') || 'None specified';
}

/** Technology inventory (guarded against LLM output variations). MOVED verbatim. */
function buildTechnologyInventory(out: string[], { research }: AnalysisMessageInput): void {
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

/** Verified / partial / gap matches from the research brief. MOVED verbatim. */
function buildMatches(out: string[], { research }: AnalysisMessageInput): void {
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

/**
 * Resume domain constraints (mandatory rules + gap boundaries).
 *
 * STRIPPED: the original directive line read "Apply these constraints
 * BEFORE and AFTER generating each bullet and section you author" -- the
 * analysis agent authors no bullets or sections. Reworded to the fit
 * assessment, archetype choice, and gap mitigations it DOES author.
 */
function buildResumeConstraints(out: string[], { research }: AnalysisMessageInput): void {
    if (!research.resumeConstraints) return;
    out.push(
        '', '### Resume Domain Constraints (MANDATORY -- Read Before Analysing)',
        'These are NON-NEGOTIABLE rules and gap boundaries from the resume domain KB.',
        'Apply these constraints when assessing fit, choosing the archetype, and',
        'composing gap mitigations -- dedicated passes apply them again when authoring bullets.',
        '--- BEGIN CONSTRAINTS ---',
        research.resumeConstraints,
        '--- END CONSTRAINTS ---',
    );
}

/**
 * Years-gap framing -- ground the fit rating in this true relevant-experience line.
 *
 * STRIPPED: the original directive line read "lead the summary with this
 * true relevant-experience framing" -- the analysis agent authors no
 * summary. Reworded to the fit rating + positioning narrative it DOES author.
 */
function buildYearsGapFraming(out: string[], { yearsGapFraming }: AnalysisMessageInput): void {
    if (!yearsGapFraming) return;
    out.push('', `YEARS GAP FRAMING (ground the fit rating and positioning narrative in this true relevant-experience framing): ${yearsGapFraming}`);
}

/**
 * Profile Intelligence -- positioning source for Phase 0 + Phase 3.
 *
 * STRIPPED: the original text named itself "the PRIMARY source for the
 * summary's S3 distinctive angle" -- the analysis agent authors no summary
 * (the summary agent reads its own separate copy of this evidence).
 * Reworded to the archetype/lead-identity and positioning-narrative fields
 * this agent DOES author.
 */
function buildProfileIntelligence(out: string[], { profileIntelligence }: AnalysisMessageInput): void {
    if (!profileIntelligence?.trim()) return;
    out.push(
        '', ANALYSIS_PROFILE_INTELLIGENCE_HEADER,
        'Code-grounded synthesis of the candidate\'s OWN GitHub: code-demonstrated direction and',
        'seniority, UNDERSOLD strengths (what the code proves but the resume under-states), and',
        'unsupported resume claims to avoid leaning on. This is a PRIMARY source for the Phase 0',
        'lead identity and the Phase 3 positioning narrative. It is NOT project case-study',
        'evidence: cite projects from the case-studies section, not from here.',
        '--- BEGIN PROFILE INTELLIGENCE ---',
        profileIntelligence.trim(),
        '--- END PROFILE INTELLIGENCE ---',
    );
}

/**
 * Closing directive -- authored fresh for the analysis agent (the writer's
 * closing referenced Phases 1-4 + the cover-letter CDATA toggle, neither of
 * which apply here).
 */
function buildClosing(out: string[]): void {
    out.push(
        '',
        'Execute Phase 0 and Phases 1-3 of the analysis framework and return the complete XML output.',
        'Do NOT include <tailored_resume_json> or <cover_letter> in your output -- dedicated passes own the resume, cover letter, experience, projects, skills, and summary.',
    );
}

/**
 * The ordered prompt-section pipeline for the analysis agent. Each runs
 * unconditionally; a section that has nothing to contribute no-ops
 * internally.
 */
export const ANALYSIS_MESSAGE_SECTIONS: readonly AnalysisMessageSection[] = [
    { name: 'research-brief',        build: buildResearchBrief },
    { name: 'company-problem',       build: buildCompanyProblem },
    { name: 'code-stack',            build: buildCodeStack },
    { name: 'role-emphasis',         build: buildRoleEmphasis },
    { name: 'requirements',          build: buildRequirements },
    { name: 'technology-inventory',  build: buildTechnologyInventory },
    { name: 'matches',               build: buildMatches },
    { name: 'resume-constraints',    build: buildResumeConstraints },
    { name: 'years-gap-framing',     build: buildYearsGapFraming },
    { name: 'profile-intelligence',  build: buildProfileIntelligence },
    { name: 'closing',               build: (out) => buildClosing(out) },
];

/** Build the user message for the Analysis Agent by running the section pipeline. */
export function buildAnalysisMessage(m: AnalysisMessageInput): string {
    const out: string[] = [];
    for (const section of ANALYSIS_MESSAGE_SECTIONS) section.build(out, m);
    return out.join('\n');
}
