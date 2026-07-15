/**
 * @format
 * The bounded Haiku repair pass: fixes ONLY the violations the deterministic
 * rules flagged, via the shared emit_resume tool. FAIL-OPEN: returns the
 * input resume on any error — a failed repair must never void a paid run.
 */
import { CLAIM_STRENGTH_RULE } from '../../../lib/resume/claim-strength.js';
import { runAgent, log } from '@bedrock/shared';
import type { AgentConfig, BasePipelineContext, StructuredResumeData } from '@bedrock/shared';
import { ResumeRewriteSchema, buildEmitResumeTool } from '../../writer/resume-tool-schema.js';
import type { ResumeViolation, ResumeGuardCtx, VerifiedEmployer } from './types.js';

const MODEL_ID = process.env['RESUME_REWRITE_MODEL'] ?? 'eu.anthropic.claude-haiku-4-5-20251001-v1:0';

/** Ledger identity for the inline prompt below — bump version on any wording change (pairs with system_prompt_hash in prompt_invocations). */
export const RESUME_REWRITE_PROMPT_META = { id: 'resume-rewrite', version: '1' } as const;

const RewriteSchema = ResumeRewriteSchema;

const TOOL = buildEmitResumeTool('Return the corrected resume as structured JSON (plain text strings, NO markdown).');

const CTX: BasePipelineContext = {
    pipelineId: 'resume-guard',
    environment: process.env['DEPLOY_ENV'] ?? 'dev',
    cumulativeTokens: { input: 0, output: 0, thinking: 0 },
    cumulativeCostUsd: 0,
};

/** One-line pitch roster for the repair prompt (extracted: no nested template literals). */
function formatPitches(pitches: ReadonlyArray<{ name: string; pitch: string }>): string {
    return pitches.map((p) => '"' + p.name + ': ' + p.pitch.slice(0, 200) + '"').join(' | ');
}

/** One-line employer-facts roster for the repair prompt. */
export function formatEmployerFacts(employers: ReadonlyArray<VerifiedEmployer>): string {
    return employers.map((e) => '[' + e.name + ': ' + e.facts.slice(0, 220) + ']').join(' ');
}

/** Rewrite instruction for experience_ungrounded, '' when no employer facts. */
function experienceFidelityRule(ctx: ResumeGuardCtx): string {
    if (!ctx.verifiedEmployers?.length) return '';
    return `For experience_ungrounded: REBUILD that employer's bullets ONLY from its verified facts below - JD-aligned vocabulary is fine, new deeds/systems/domains are not: ${formatEmployerFacts(ctx.verifiedEmployers)}`;
}

/** Haiku rewrite that fixes ONLY the flagged issues. FAIL-OPEN: returns the input on error. */
export async function rewriteResume(
    resume: StructuredResumeData,
    violations: ResumeViolation[],
    ctx: ResumeGuardCtx,
): Promise<StructuredResumeData> {
    const system = [
        'You repair a tailored resume, fixing ONLY the listed issues by REORDERING and REWORDING for prominence. Call emit_resume with the full resume JSON.',
        `NEVER fabricate, NEVER change a number or date, NEVER rename a degree — the verified degree names are: ${ctx.verifiedEducation.join('; ')}.`,
        `Make the summary's FIRST sentence lead with this identity differentiator: "${ctx.leadIdentity}" — never an infrastructure-first opener; never name or concede any experience gap.`,
        'For summary_opens_with_employer: keep the differentiator\'s CONTENT but rephrase the opening so it does not START with an employer\'s name — a summary opening "AWS … engineer" written by someone employed at AWS reads as a title held there. Name the platform mid-sentence instead ("Cloud engineer … on AWS" / "inside AWS production operations").',
        'For experience_bullet_jd_echo: rewrite the flagged bullet using ONLY that employer\'s verified facts (rephrasing and emphasis are fine); JD vocabulary may appear only where those facts support it - never invent deeds or a new domain to fit the JD.',
        ctx.projectPitches?.length
            ? `For project_restates_bullets and project_pitch_missing: rewrite each flagged project description in three beats — (1) open with its documented pitch: ${formatPitches(ctx.projectPitches)}; (2) ONE JD-relevant differentiator not already an experience bullet; (3) one metric not used elsewhere. No stack enumerations.`
            : 'For project_restates_bullets: rewrite the flagged project description as pitch (what it is, who it is for, the problem it solves) + one JD-relevant differentiator + one fresh metric. Remove numbers duplicated from experience bullets and all stack enumerations.',
        ctx.companyProblem ? `For summary_restates_bullets: rewrite the summary at ALTITUDE — S1 identity anchor + capability ("<Role-family> engineer who builds…"), S2 ONE sentence bridging to this problem (paraphrased): "${ctx.companyProblem.slice(0, 400)}", S3 the concrete paid-experience anchor, S4 qualitative rigor close ("every change gated by automated tests and policy-as-code"). Remove EVERY number that also appears in an experience bullet — counts belong to bullets.` : 'For summary_restates_bullets: rewrite the summary at altitude — identity anchor, problem bridge, concrete paid-experience anchor, qualitative rigor close; remove every number that also appears in an experience bullet.',
        'For headline_is_title: rewrite profile.title as a DESCRIPTIVE domain/capability headline with NO job-title noun (Engineer, Associate, Analyst, Manager, Developer, Specialist, Lead, Architect, Consultant…) — e.g. "Cloud & AI Operations · Python Automation & Incident Response". Never claim a role the candidate does not hold.',
        'For selected_work_misplaced: MOVE the "Selected work"/GitHub links highlight OUT of the support/customer/QA role and into the most senior builder/engineering role\'s highlights (e.g. Freelance / Cloud & DevOps). If no builder/engineering role exists, DROP that highlight. Never leave it under a support/customer-facing role.',
        `Put the "${ctx.archetypeSkillLead}" skill group FIRST (if present); within each group, JD-matched terms first.`,
        'Within each experience role, lead with the strongest number-led bullet.',
        'For compliance_overclaim: reframe as the MECHANISM — "policy-as-code gate (Checkov custom rules + CDK-Nag rule packs: HIPAA, NIST 800-53, PCI DSS) failing the pipeline on CRITICAL/HIGH misconfigurations". Frameworks named ONLY as rule packs, never as achieved compliance.',
        'For bullet_metric_stuffed: rewrite the flagged bullet(s) around ONE idea with the strongest IMPACT metric (or one before/after pair, e.g. "30 seconds vs 8 minutes"); move or drop inventory counts (N stacks, N workflows, N rules) — keep at most 3 inventory numbers across the whole experience section.',
        'For summary_echoes_bullets: DELETE the echoing sentence(s) and replace with (a) one sentence bridging to the company problem and (b) one distinctive angle that is NOT an experience bullet. The summary positions; bullets prove.',
        'For summary_missing_problem_bridge: add ONE sentence connecting the candidate\'s proven approach to the company problem (paraphrased, first sentence or second).',
        ctx.verifiedEmployers?.length
            ? `For summary_employer_project_conflation: SPLIT the flagged sentence — the employer sentence may carry ONLY that employer's verified facts: ${formatEmployerFacts(ctx.verifiedEmployers)}. The project sentence is SEPARATE and opens with the solo framing ("Solo-building Tucaken, …"). Never join employer and project claims with a semicolon or comma chain.`
            : 'For summary_employer_project_conflation: split the flagged sentence so the employer anchor and the solo-project bridge are separate sentences; each claim stays with the entity it belongs to.',
        'For summary_identity_echoes_problem: rewrite the FIRST sentence using ONLY the candidate\'s own capability vocabulary — remove every phrase borrowed from the company problem (no "so <their> teams ship…", no bottleneck framing). The candidate is a solo builder: never claim outcomes delivered for internal teams.',
        'For summary_describes_job: rewrite the flagged sentence in CANDIDATE voice — state what the candidate brings to this problem class, never what the role/employer needs. Delete "this role exists to…"/"they need…" phrasing and any mission recitation; a summary describes the candidate, the reader already knows their own mission.',
        `For summary_names_target_company: remove the target company's name ("${ctx.targetCompany ?? ''}") from the summary entirely — keep the capability content, drop the name. A summary naming the employer is single-use and reads as recitation.`,
        'For unbridged_transferable_claim: restate each flagged term with its honest transfer framing in the same clause (e.g. "AWS CDK, transferable to Terraform") — or remove the term. Never leave a flat claim of a tool the candidate has not used.',
        experienceFidelityRule(ctx),
        'NEVER increase total length: the corrected resume must have the SAME or FEWER total words than the input. A fix rewrites in place; it never adds new prose elsewhere.',
        'NEVER remove an entire experience role — every role in the input resume must appear in the output, even when trimming.',
        'Preserve every fact, all education names verbatim, and the profile identity. Output plain-text strings, no markdown.',
        CLAIM_STRENGTH_RULE,
    ].join('\n');

    const config: AgentConfig = {
        agentName: 'resume-rewrite',
        promptId: RESUME_REWRITE_PROMPT_META.id,
        promptVersion: RESUME_REWRITE_PROMPT_META.version,
        modelId: MODEL_ID,
        maxTokens: 8000,
        thinkingBudget: 0,
        systemPrompt: [{ text: system }],
        pipeline: 'job-strategist',
        tool: { name: TOOL.name, description: TOOL.description, inputSchema: TOOL.input_schema as Record<string, unknown> },
    };

    const userMessage = `<issues>${violations.map((v) => v.code).join(', ')}</issues>\n<resume>${JSON.stringify(resume)}</resume>`;

    try {
        const result = await runAgent<StructuredResumeData>({
            config, userMessage, pipelineContext: CTX,
            parseResponse: (s) => {
                const parsed = RewriteSchema.safeParse(JSON.parse(s));
                if (!parsed.success) throw new Error(`resume-rewrite: ${parsed.error.message}`);
                return parsed.data as unknown as StructuredResumeData;
            },
        });
        return result.data;
    } catch (e) {
        log('WARN', 'resume rewrite failed — keeping original', { error: e instanceof Error ? e.message : String(e) });
        return resume;
    }
}
