/**
 * @format
 * Project Case-Study Agent — Bedrock tool-use, Sonnet 4.6.
 *
 * One invocation per project. The model receives the full
 * `CaseStudyContext` (project + components + repos + commits + KB
 * chunks) and emits a single structured `CaseStudy` payload covering
 * every section: tagline, pitch, stack, decisions, highlights,
 * challenges, depth markers, architecture diagram, resume bullets per
 * angle.
 *
 * Why Sonnet rather than Haiku: case-study output is the headline
 * recruiter-facing surface and is read directly by humans. Clustering's
 * job (Haiku) is to pick groupings from signals; case-study's job is to
 * write convincing prose grounded in those repos. We mirror the
 * research(Haiku)+writer(Sonnet) split already used by the article
 * pipeline.
 *
 * Like clustering-agent, this module exposes a `ClusteringAgent`-style
 * interface so tests can inject a mock implementation without spinning
 * up Bedrock.
 */
import { createHash } from 'node:crypto';

import { runAgent, parseJsonResponse } from '../agent-runner.js';
import { clampOversizedFields, coerceArchitectureString } from './case-study-schema-repair.js';
import type { BasePipelineContext } from '../base-agent.js';
import type { AgentConfig, AgentResult } from '../types.js';

import {
    CaseStudySchema,
    PROJECT_TYPES,
    RESUME_BULLET_ANGLES,
    STACK_CATEGORIES,
    type CaseStudy,
    type CaseStudyContext,
} from './case-study-types.js';
import { PROJECT_COMPONENT_KINDS } from './types.js';

// ─── Configuration ──────────────────────────────────────────────────────────

const CASE_STUDY_MODEL =
    process.env.CASE_STUDY_MODEL ??
    'eu.anthropic.claude-sonnet-4-6';

const EFFECTIVE_MODEL_ID =
    process.env.INFERENCE_PROFILE_ARN ?? CASE_STUDY_MODEL;

// Sonnet 4-6 supports up to 64k output tokens. The full case study (pitch +
// tagline + stack + decisions + highlights + challenges + depth markers +
// architecture + resume bullets across angles) is large structured JSON; 16k
// truncated multi_repo runs (stopReason='max_tokens' → thrown). 32k gives the
// generation room while staying well under both the output max and, combined
// with the 120k context budget, the overall context window.
const CASE_STUDY_MAX_TOKENS = 32_768;

/** Forced tool_use is incompatible with extended thinking. */
const CASE_STUDY_THINKING_BUDGET = 0;

// ─── System prompt ──────────────────────────────────────────────────────────

const SYSTEM_PROMPT_TEXT = `You are a portfolio editor writing the case study for a single project.
The project may span multiple repositories. Your output is read by
recruiters and engineers; treat every claim as something the author may
be asked about in an interview.

Lead with the PRODUCT, then the engineering. A recruiter must understand
what the thing IS, who it's for, and what problem it solves BEFORE any
stack or architecture detail. A pitch that opens with infrastructure
("a platform spanning four repositories running 14 microservices…") and
never says what the product does has failed, no matter how impressive the
internals.

Synthesise ONE coherent project story across all repositories and
components. Do NOT narrate repo-by-repo. The pitch opens with what the
combined product is and does as a whole; a member repo's role is
mentioned only in service of that one story.

Rules:
  1. Every decision / challenge / stack item MUST cite at least one
     concrete piece of evidence in \`sourceSignals.commits\`,
     \`sourceSignals.pulls\`, or \`sourceSignals.files\`. Pull requests
     are the strongest form of evidence — when one is available for a
     decision, prefer it over a commit. If you cannot cite evidence,
     do not include the row. Loose hand-waving is worse than omitting
     the section. A <fileChanges> block, when present, lists the
     most-changed files with their churn — cite those paths in
     \`sourceSignals.files\` to ground a challenge or highlight in WHAT
     changed, not just the commit message.
     Lead the engineering sections (decisions, challenges, highlights)
     with what the commits and pull requests show was built, and who built it
     (commit + PR \`authorLogin\`) — the work and the collaboration are the spine.
     Each engineering row narrates real work the commits/PRs demonstrate;
     cite that same evidence in \`sourceSignals\`.
  2. PRODUCT CONTEXT: when a <productContext> block is supplied, it is
     GROUND TRUTH about what the product is, who it serves, and the
     problem it solves. Treat it as authoritative — it is a given, NOT a
     claim, so it is EXEMPT from the evidence-citation rule above. Use it
     to frame the tagline and the FIRST paragraph of the pitch. Never
     contradict it or invent product purpose beyond it. If no
     <productContext> is supplied, infer the product's purpose from the
     repositories/components and README-style KB passages — still lead
     with what it does, not how it's built.
  3. \`displayName\` is the project's recruiter-facing PRODUCT name
     (max 80 chars) — how its landing page would title it. NEVER a
     repository name or slug: no kebab-case or snake_case identifiers
     (a name like "frontend-portfolio" must become a real product name,
     e.g. "Lami — AI-Assisted Portfolio"). A named feature may lead the
     name when it is the differentiator.
     The \`tagline\` is a single sentence under 200 characters that says
     what the product is and who it's for (not a tech-stack summary).
     The \`pitch\` is at most three short paragraphs: paragraph 1 = what
     it does + who it's for + the problem it solves (from productContext);
     paragraphs 2–3 = the engineering approach and depth. Written in the
     candidate's voice ("I built" / "I designed", never "we built").
  4. \`decisions\` are ADR-style: title, context (problem), decision
     (what was chosen), consequences. At most 5.
     Select decisions the way a hiring panel reads them — as proof of
     JUDGEMENT across the project's WHOLE history (use
     <difficultySignals> where supplied), not a log of recent changes.
     When the evidence supports it, include at least one decision about
     the product's differentiating capability (e.g. how its AI feature
     is grounded), not only platform plumbing.
     \`context\` must name the alternative option(s) considered and why
     they were rejected — that comparison is the senior-judgement
     signal. Evidence-gated: if the commits/docs show no alternative,
     state the constraint that forced the choice instead; NEVER invent
     an option that was not really on the table.
     \`consequences\` lead with what the decision ACHIEVED — for users,
     security, cost or reliability, quantified when the evidence
     supports a number — and only then state the honest tradeoff.
     Example shape: "Eliminated the frontend's entire AWS credential
     surface and gave the data contract a single owner. The cost: the
     site depends on the in-cluster BFF, mitigated by graceful
     build-time degradation."
     \`confidence\` is calibrated, not decorative: 'high' ONLY when the consequence is
     validated by production evidence cited in sourceSignals (a live
     metric, a measured result, a verified deploy); otherwise 'medium',
     or 'low' when the outcome is expected but unmeasured.
  5. \`challenges\` answer "tell me about a hard problem you solved" —
     each is a problem / solution pair grounded in real commits or
     issues. At most 5.
     Select the project's DEFINING difficulties across its WHOLE
     history — an outage class eliminated, a migration survived, a
     security or observability model built — not merely the most recent
     bug-fixes. At most 2 of the 5 may be single-incident debugging
     stories. When a <difficultySignals> block is supplied, it maps —
     from the FULL commit history — the areas with the most sustained
     fix activity and the project's overall active span; treat it as
     the measured record of where the real battles were, prefer
     challenges it supports, and treat its counts as approximate.
     The problem's FIRST sentence states what was broken and what was
     at risk in plain language a non-engineer can follow; technical
     specifics come after.
     Solutions narrate the engineering — the diagnosis, the decision
     taken and why, the outcome — in the candidate's voice. Name at
     most ONE identifying code detail (a flag, a function, a config
     key) as evidence colour; NEVER transcribe configuration or code
     from the commits — the receipts belong in \`sourceSignals\`, not
     in the prose.
  6. \`highlights\` are 3–5 things a recruiter could point to in 5
     seconds: shipped features, scale numbers, public outcomes.
     A highlight or challenge TITLE must lead with the WORK or OUTCOME —
     never with a repository name (no "tucaken-infra: …") and never with a
     roll-call of technologies ("EKS, Karpenter, ArgoCD, Prometheus …").
     Name a repo or a technology only afterwards, as supporting detail.
     At least ONE highlight must state the project's headline capability
     in plain language — what its primary audience can do with it or
     what it delivers for them. Calibrate to the project's nature: for
     an application, what a user or visitor can DO; for infrastructure
     or IaC, what it provisions, automates or operates and for whom; for
     a library or CLI, what it lets a developer build or skip; for a
     data/ML project, what question it answers. A non-technical
     recruiter must understand that highlight without knowing the stack.
     When any highlight cites a measurement, give its plain-English
     meaning before the number and metric name — "pages render in about
     0.13 seconds (132 ms LCP)", never an acronym-led bare figure.
     Choose WHICH highlights to write by answering the questions a
     hiring panel asks about a project like this, using the strongest
     available evidence: what does it do and for whom? what makes it
     distinctive (e.g. an AI capability)? how is it secured, and how
     does it run and deploy in production? what proves engineering
     discipline? Answer a question ONLY when the evidence supports it —
     never emit a box-ticking claim ("hosted on the cloud") without
     real work behind it. Routine facts a reader can find elsewhere
     (language, database, protocol) belong in \`stack\` and
     \`architecture\`, not in a highlight.
  7. \`resumeBullets\`: at most 3 sets — pick only the angles this
     project most strongly evidences. Bullets are past-tense, quantified
     where possible, never longer than 250 characters. Omit angles that
     don't apply to this project.
  8. \`architecture\` is a Mermaid graph (graph LR or graph TD).
     Rectangles for services, cylinders for datastores, clouds for
     external services. Keep it readable in 5 seconds. For a line break
     inside a node label use \`<br/>\` and WRAP THE WHOLE LABEL IN DOUBLE
     QUOTES, never a literal "\\n". Quote any label containing punctuation,
     e.g. \`App["admin-api BFF<br/>Hono"]\` -- never \`App[admin-api BFF\\nHono]\`.

Distinctness across sections: decisions, challenges and highlights are
three different lenses, not three retellings. A single work arc may
appear in at most one section unless each appearance adds genuinely
distinct substance — the decision is WHY a path was chosen, the
challenge is HOW a hard problem was beaten, the highlight is WHAT
outcome a recruiter can verify in five seconds. Never repeat sentences
or near-identical text across sections; a story that earns two slots
must say something different in each.

The input is a compact JSON envelope describing the project, its
components, its repositories, recent commits, and selected KB passages,
plus an optional <productContext> block. Use <productContext> for the
product framing (tagline + first pitch paragraph) and commits + KB
passages as evidence for every grounded engineering claim.

When a <verifiedStack> block is supplied, it lists the project's REAL
code dependencies (extracted from package manifests, IaC, and
Dockerfiles) with their actual versions. Your \`stack\` MUST be drawn from these
— prefer their exact names so each item can be tied back to a
real dependency. Do NOT list a language/framework/database/service that
is absent from <verifiedStack> unless a commit, PR, or KB passage clearly
evidences it. Do not put version numbers in stack names; versions are
attached deterministically after generation.
verifiedStack is the tech the work USED — a grounding aid for the
\`stack\` section, NOT the thing the narrative is organised around. Never
structure the pitch, decisions, or highlights around the tech list;
organise them around the work and its outcomes, then let the verified
tech ground the stack. Do NOT devote a pitch paragraph to one
repository's infrastructure rendered as a list of technologies — every
paragraph stays part of the one combined story, led by what was built.

Narrate real, evidenced work plainly and confidently. The author did
this work — state it directly. Avoid hedged phrasing ("claimed",
"attempted to", "appears to") and never use "we built". If a row is
grounded enough to include, it is grounded enough to state plainly.`;

/**
 * Build the system prompt, appending an archetype/stage calibration block
 * when the context carries a classified archetype. Soft guidance only — it
 * shifts section emphasis; it never changes the output schema, the evidence
 * requirement, or the grounding pass. Absent archetype → base prompt verbatim.
 */
// Appended when a prior case study is supplied — turns the run into an
// incremental refine rather than a from-scratch write.
const REFINE_PROMPT_BLOCK = `
REFINE MODE — a prior case study for this project is supplied in <priorCaseStudy>.
The project has changed since it was written (typically a repository was added).
Produce the UPDATED full case study, not a fresh one:
  - PRESERVE prior decisions / challenges / highlights / stack that are still
    accurate. Reuse their \`sourceSignals\` verbatim — those rows are already
    grounded; you do not need new evidence to keep them.
  - RESTRUCTURE tech-led prior rows: preservation applies to the EVIDENCE
    (\`sourceSignals\`), NOT to tech-led phrasing. If a prior highlight or
    challenge title leads with a repository name ("tucaken-infra: …") or a
    roll-call of technologies, REWRITE the title and text to lead with the work
    and its outcome — keep the grounding, drop the tech-spine framing. Likewise
    rewrite any prior pitch paragraph that reads as one repo's tech list.
  - ADD rows for work shown by the newly-supplied commits / pulls / KB that the
    prior case study missed. Ground every new row in that evidence.
  - DROP a prior row only if it is now wrong or superseded.
  - REVISE the tagline, pitch, architecture, and resume bullets so they describe
    the project AS IT NOW STANDS across all repositories and components.
  - Do NOT duplicate a prior item with reworded text. Respect the same caps
    (≤5 decisions, ≤5 highlights, ≤5 challenges).
  - COVERAGE: any repository listed in <newRepos> is newly added and absent from
    the prior case study. Each one MUST appear in at least one highlight AND one
    challenge, grounded in its commits/pulls/files — drop or merge a weaker prior
    item to make room within the caps if needed. A new repo that only shows up in
    the stack list is NOT sufficient.`;

// A short, deterministic fingerprint of the static prompt surface
// (SYSTEM_PROMPT_TEXT + REFINE_PROMPT_BLOCK). Folded into the case-study cache
// key (`computeInputHash`) so that ANY edit to the prompt automatically busts
// the semantic cache — a prompt refinement then takes effect on the next
// regenerate of an otherwise-unchanged project, with no manual version bump.
// The dynamic calibration block is already reflected in the cache key via the
// archetype/stage/section fields, so it is intentionally excluded here.
export const CASE_STUDY_PROMPT_VERSION = createHash('sha256')
    .update(SYSTEM_PROMPT_TEXT)
    .update(REFINE_PROMPT_BLOCK)
    .digest('hex')
    .slice(0, 12);

export function buildSystemPrompt(context: CaseStudyContext): string {
    let prompt = SYSTEM_PROMPT_TEXT;
    if (context.archetype) {
        const stageLabel = context.stage ?? 'unspecified';
        const priority   = (context.prioritySections ?? []).join(', ');
        const deemph     = (context.deemphasizedSections ?? []).join(', ');
        const block = [
            '',
            'Project calibration:',
            `This is a ${stageLabel}-level ${context.archetype.name} project.` +
                (priority ? ` Recruiters at this level look hardest at: ${priority}. Prioritise depth and evidence in those sections.` : ''),
            deemph ? `De-emphasise: ${deemph}.` : '',
            'Still emit every section the evidence supports — calibration changes emphasis, never truthfulness. Omit any section you cannot ground.',
        ].filter(Boolean).join('\n');
        prompt = `${prompt}\n${block}`;
    }
    if (context.evidenceMix) {
        const m = context.evidenceMix;
        prompt = `${prompt}\n\nEvidence mix (measured from the ingested repository data): ` +
            `application code ~${m.appPct}% vs infrastructure/IaC ~${m.infraPct}% of classified files. ` +
            'When both lanes hold a meaningful share (roughly 20% or more each), balance the ' +
            'highlights and decisions across them in about that proportion — one lane must not take every slot. ' +
            'When one lane dominates, weight the highlights accordingly and do not invent work ' +
            'in the minor lane.';
    }
    if (context.priorCaseStudy) prompt = `${prompt}\n${REFINE_PROMPT_BLOCK}`;
    return prompt;
}

// ─── Forced tool_use schema ─────────────────────────────────────────────────

const SOURCE_SIGNAL_SCHEMA = {
    type: 'object',
    properties: {
        commits: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    repoFullName: { type: 'string' },
                    sha:          { type: 'string', pattern: '^[0-9a-f]{7,40}$' },
                    authoredAt:   { type: 'string' },
                    message:      { type: 'string' },
                },
                required: ['repoFullName', 'sha', 'authoredAt', 'message'],
                additionalProperties: false,
            },
        },
        pulls: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    repoFullName: { type: 'string' },
                    number:       { type: 'integer', minimum: 1 },
                    title:        { type: 'string' },
                    htmlUrl:      { type: 'string', format: 'uri' },
                    mergedAt:     { type: ['string', 'null'] },
                },
                required: ['repoFullName', 'number', 'title', 'htmlUrl', 'mergedAt'],
                additionalProperties: false,
            },
        },
        files: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    repoFullName: { type: 'string' },
                    path:         { type: 'string' },
                    chunkId:      { type: 'string', format: 'uuid' },
                },
                required: ['repoFullName', 'path'],
                additionalProperties: false,
            },
        },
        ungroundedClaims: { type: 'array', items: { type: 'string' } },
        grounding:        { type: 'string', enum: ['GROUNDED', 'NOT_GROUNDED', 'NOT_VERIFIED'] },
    },
    required: ['commits', 'pulls', 'files', 'ungroundedClaims', 'grounding'],
    additionalProperties: false,
};

const STACK_ITEM_SCHEMA = {
    type: 'object',
    properties: {
        category:      { type: 'string', enum: [...STACK_CATEGORIES] },
        name:          { type: 'string', minLength: 1, maxLength: 80 },
        justification: { type: 'string', maxLength: 2000 },
        componentName: { type: 'string', maxLength: 80 },
        sourceSignals: SOURCE_SIGNAL_SCHEMA,
    },
    required: ['category', 'name', 'justification', 'sourceSignals'],
    additionalProperties: false,
};

const DECISION_SCHEMA = {
    type: 'object',
    properties: {
        title:         { type: 'string', minLength: 1, maxLength: 200 },
        context:       { type: 'string', maxLength: 2000 },
        decision:      { type: 'string', maxLength: 2000 },
        consequences:  { type: 'string', maxLength: 2000 },
        confidence:    { type: 'string', enum: ['high', 'medium', 'low'] },
        sourceSignals: SOURCE_SIGNAL_SCHEMA,
    },
    required: ['title', 'context', 'decision', 'consequences', 'confidence', 'sourceSignals'],
    additionalProperties: false,
};

const HIGHLIGHT_SCHEMA = {
    type: 'object',
    properties: {
        title:         { type: 'string', minLength: 1, maxLength: 200 },
        description:   { type: 'string', minLength: 1, maxLength: 2000 },
        sourceSignals: SOURCE_SIGNAL_SCHEMA,
    },
    required: ['title', 'description', 'sourceSignals'],
    additionalProperties: false,
};

const CHALLENGE_SCHEMA = {
    type: 'object',
    properties: {
        problem:       { type: 'string', minLength: 1, maxLength: 2000 },
        solution:      { type: 'string', minLength: 1, maxLength: 2000 },
        sourceSignals: SOURCE_SIGNAL_SCHEMA,
    },
    required: ['problem', 'solution', 'sourceSignals'],
    additionalProperties: false,
};

const RESUME_BULLET_SET_SCHEMA = {
    type: 'object',
    properties: {
        angle:   { type: 'string', enum: [...RESUME_BULLET_ANGLES] },
        bullets: {
            type: 'array',
            minItems: 1, maxItems: 8,
            items: { type: 'string', minLength: 1, maxLength: 250 },
        },
    },
    required: ['angle', 'bullets'],
    additionalProperties: false,
};

const ARCHITECTURE_SCHEMA = {
    type: 'object',
    properties: {
        diagramFormat: { type: 'string', enum: ['mermaid', 'svg'] },
        diagramSource: { type: 'string', minLength: 1 },
        nodes: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    id:    { type: 'string' },
                    label: { type: 'string' },
                    kind:  { type: 'string', enum: [...PROJECT_COMPONENT_KINDS] },
                },
                required: ['id', 'label', 'kind'],
                additionalProperties: false,
            },
        },
        edges: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    from:  { type: 'string' },
                    to:    { type: 'string' },
                    label: { type: 'string' },
                },
                required: ['from', 'to'],
                additionalProperties: false,
            },
        },
    },
    required: ['diagramFormat', 'diagramSource', 'nodes', 'edges'],
    additionalProperties: false,
};

export const CASE_STUDY_TOOL = {
    name: 'emit_case_study',
    description: 'Emit the full case study for a single project.',
    inputSchema: {
        type: 'object',
        properties: {
            displayName:   { type: 'string', minLength: 1, maxLength: 80 },
            tagline:       { type: 'string', minLength: 1, maxLength: 200 },
            pitch:         { type: 'string', minLength: 1, maxLength: 4000 },
            stack:         { type: 'array', maxItems: 40, items: STACK_ITEM_SCHEMA },
            decisions:     { type: 'array', maxItems: 5,  items: DECISION_SCHEMA },
            highlights:    { type: 'array', maxItems: 5,  items: HIGHLIGHT_SCHEMA },
            challenges:    { type: 'array', maxItems: 5,  items: CHALLENGE_SCHEMA },
            architecture: ARCHITECTURE_SCHEMA,
            resumeBullets: {
                // 3, not RESUME_BULLET_ANGLES.length: resumeBullets dominate
                // output tokens, and a project rarely evidences more than 3
                // angles. The Zod gate still accepts up to 6 (cached artefacts).
                type: 'array',
                minItems: 1, maxItems: 3,
                items: RESUME_BULLET_SET_SCHEMA,
            },
        },
        required: [
            'displayName', 'tagline', 'pitch', 'stack', 'decisions',
            'highlights', 'challenges', 'architecture', 'resumeBullets',
        ],
        additionalProperties: false,
    },
};

// ─── User message ───────────────────────────────────────────────────────────

/**
 * Append the optional code-grounded evidence blocks to the user message.
 * Extracted from buildUserMessage to keep its complexity bounded as
 * evidence lanes are added.
 */
function appendEvidenceBlocks(lines: string[], ctx: CaseStudyContext): void {
    // Real file-level change evidence (from ingested commit diffs). The agent may
    // cite these paths in sourceSignals.files to ground challenges/highlights in
    // WHAT changed, not just commit messages.
    if (ctx.fileChangeEvidence && ctx.fileChangeEvidence.length > 0) {
        lines.push(
            '<fileChanges>',
            JSON.stringify(ctx.fileChangeEvidence),
            '</fileChanges>',
        );
    }
    // Real code dependencies (technology_evidence: Syft/treesitter/IaC/Docker),
    // each with its actual version + canonical purl. The stack must reflect
    // these; do not invent a dependency that is absent here and unevidenced.
    if (ctx.verifiedStack && ctx.verifiedStack.length > 0) {
        lines.push(
            '<verifiedStack>',
            JSON.stringify(ctx.verifiedStack),
            '</verifiedStack>',
        );
    }
    // Fix-density map over the FULL commit history (~200 tokens) — lets the
    // challenges section see battles that predate the packed recency window.
    if (ctx.difficultySignals) {
        lines.push(
            '<difficultySignals>',
            JSON.stringify(ctx.difficultySignals),
            '</difficultySignals>',
        );
    }
}

export function buildUserMessage(ctx: CaseStudyContext): string {
    // Trim to the project envelope the model needs. We deliberately do not
    // forward `user_overrides` here — sticky-edit enforcement lives at the
    // persistence layer.
    const envelope = {
        projectName:  ctx.projectName,
        tagline:      ctx.tagline,
        pitch:        ctx.pitch,
        components:   ctx.components,
        repositories: ctx.repositories,
        commits:      ctx.commits,
        pulls:        ctx.pulls,
    };
    const lines = [
        '<project>',
        JSON.stringify(envelope),
        '</project>',
    ];
    if (ctx.productContext && ctx.productContext.trim().length > 0) {
        lines.push(
            '<productContext>',
            ctx.productContext,
            '</productContext>',
        );
    }
    lines.push(
        '<kbChunks>',
        JSON.stringify(ctx.kbChunks),
        '</kbChunks>',
    );
    appendEvidenceBlocks(lines, ctx);
    if (ctx.priorCaseStudy) {
        lines.push(
            '<priorCaseStudy>',
            JSON.stringify(ctx.priorCaseStudy),
            '</priorCaseStudy>',
        );
        if (ctx.refineNewRepos && ctx.refineNewRepos.length > 0) {
            lines.push(
                '<newRepos>',
                JSON.stringify(ctx.refineNewRepos),
                '</newRepos>',
            );
        }
    }
    lines.push('', `Emit the ${CASE_STUDY_TOOL.name} tool now.`);
    return lines.join('\n');
}

// ─── Entrypoint ─────────────────────────────────────────────────────────────

export interface CaseStudyAgent {
    invoke(
        context: CaseStudyContext,
        ctx:     BasePipelineContext,
    ): Promise<AgentResult<CaseStudy>>;
}

/**
 * A schema-validation failure that survived the deterministic repair pass.
 * Carries the formatted Zod issue detail so the bounded retry can feed it back
 * to the model.
 */
export class CaseStudySchemaError extends Error {
    constructor(public readonly detail: string) {
        super(`case-study output failed schema: ${detail}`);
        this.name = 'CaseStudySchemaError';
    }
}

/**
 * Parse + validate the model's `emit_case_study` payload. Applies the zero-cost
 * deterministic repairs first (coerce a string `architecture` into its object
 * form; clamp length overruns) and re-validates once. Throws
 * {@link CaseStudySchemaError} with the remaining issues if it still fails — the
 * caller can feed that detail back for ONE bounded model retry.
 */
export function parseCaseStudyResponse(text: string): CaseStudy {
    const raw = parseJsonResponse<unknown>(text, 'project-case-study');
    let parsed = CaseStudySchema.safeParse(raw);
    if (!parsed.success) {
        // Deterministic, zero-cost repairs, then re-validate once. No model call.
        let repaired = coerceArchitectureString(raw, parsed.error.issues);
        repaired = clampOversizedFields(repaired, parsed.error.issues);
        parsed = CaseStudySchema.safeParse(repaired);
    }
    if (!parsed.success) {
        throw new CaseStudySchemaError(JSON.stringify(parsed.error.issues));
    }
    return parsed.data;
}

/** Schema-issue detail if `err` is a case-study schema failure, else null. */
function schemaFailureDetail(err: unknown): string | null {
    // runAgent wraps parseResponse's throw in AgentExecutionError (.cause).
    const cause = (err as { cause?: unknown })?.cause;
    if (cause instanceof CaseStudySchemaError) return cause.detail;
    if (err instanceof CaseStudySchemaError)   return err.detail;
    return null;
}

export const bedrockCaseStudyAgent: CaseStudyAgent = {
    async invoke(context, ctx) {
        const config: AgentConfig = {
            agentName:      'project-case-study',
            modelId:        EFFECTIVE_MODEL_ID,
            maxTokens:      CASE_STUDY_MAX_TOKENS,
            thinkingBudget: CASE_STUDY_THINKING_BUDGET,
            systemPrompt:   [{ text: buildSystemPrompt(context) }],
            pipeline:       'project-case-study',
            promptId:       'project-case-study-v1',
            tool:           CASE_STUDY_TOOL,
        };

        // Silence unused — kept for explicit documentation that this set
        // is the allowable project types.
        void PROJECT_TYPES;

        const userMessage = buildUserMessage(context);
        try {
            return await runAgent<CaseStudy>({
                config, userMessage, pipelineContext: ctx,
                parseResponse: parseCaseStudyResponse,
            });
        } catch (err) {
            const detail = schemaFailureDetail(err);
            if (!detail) throw err;   // not a schema failure — propagate untouched

            // ONE bounded repair retry: feed the exact violations back so the
            // model fixes ONLY those, keeping the (already-paid-for) content.
            // Single attempt, agent-only — it never re-triggers the pipeline, and
            // both calls' Bedrock cost is booked by runAgent regardless of outcome.
            console.warn(`[project-case-study] schema repair retry (1/1): ${detail}`);
            const retryMessage =
                `${userMessage}\n\nYour previous emit_case_study call FAILED schema validation:\n${detail}\n` +
                'Return a corrected emit_case_study tool call. Fix ONLY those violations — in ' +
                'particular `architecture` MUST be an object {diagramFormat, diagramSource, nodes, edges} ' +
                '(never a bare string), and every string must respect its maxLength. Keep all other content identical.';
            return await runAgent<CaseStudy>({
                config, userMessage: retryMessage, pipelineContext: ctx,
                parseResponse: parseCaseStudyResponse,
            });
        }
    },
};
