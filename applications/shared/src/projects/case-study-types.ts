/**
 * @format
 * Zod schemas + TS types for the project case-study generation output.
 *
 * One agent invocation per project. The agent is forced (via Bedrock
 * tool_use) to emit the entire case study in a single structured payload;
 * the persistence layer fans it out across the per-section tables.
 *
 * The angle / category enums mirror migrations 030 and 031 — the source
 * of truth lives in SQL, this file just shadows it for runtime
 * validation.
 */
import { z } from 'zod';

import { PROJECT_COMPONENT_KINDS } from './types.js';

// ─── Enum families ──────────────────────────────────────────────────────────

export const PROJECT_TYPES = [
    'side_project', 'open_source', 'production_saas',
    'client_work', 'internal_tool', 'learning_project',
] as const;

export const PROJECT_STATUS = ['active', 'stable', 'dormant', 'archived'] as const;

export const RESUME_BULLET_ANGLES = [
    'backend', 'frontend', 'infrastructure',
    'fullstack', 'data_ml', 'product_leadership',
] as const;

export const STACK_CATEGORIES = [
    'language', 'framework', 'database',
    'infrastructure', 'observability', 'ci_cd', 'external_service',
] as const;

export const TEST_COVERAGE_SIGNALS = ['none', 'light', 'moderate', 'strong'] as const;
export const CI_MATURITY = ['none', 'basic', 'deploys_to_prod', 'multi_env'] as const;
export const DOC_DENSITY = ['none', 'readme_only', 'docs_dir', 'comprehensive'] as const;

// ─── Evidence trail ─────────────────────────────────────────────────────────

/**
 * The shape stored in `source_signals` JSONB columns. Every AI-inferred
 * row of decisions / challenges / stack-items / etc. carries one of these
 * so the recruiter-facing UI can show "evidence:" links back to specific
 * commit SHAs and source files.
 */
export const SourceSignalSchema = z.object({
    commits: z.array(z.object({
        repoFullName: z.string(),
        sha:          z.string().regex(/^[0-9a-f]{7,40}$/i),
        authoredAt:   z.string(),
        message:      z.string(),
    }).strict()).default([]),
    /**
     * Pull-request evidence. Populated when the orchestrator was given a
     * `PullRequestLoader` (GitHubAdapter.listPullRequests in production).
     * The number is the public `#<n>` reference; `htmlUrl` is the
     * recruiter-visible deep link.
     */
    pulls: z.array(z.object({
        repoFullName: z.string(),
        number:       z.number().int().positive(),
        title:        z.string(),
        htmlUrl:      z.string().url(),
        mergedAt:     z.string().nullable(),
    }).strict()).default([]),
    files: z.array(z.object({
        repoFullName: z.string(),
        path:         z.string(),
        /**
         * Optional chunk id from `document_embeddings` that the model
         * used as evidence. The retrieval layer is what produces these,
         * not the model.
         */
        chunkId:      z.string().uuid().optional(),
    }).strict()).default([]),
    /**
     * Lines from the BedrockGroundingVerifier (mode='flag') marking
     * portions of the generated text the verifier could not match back
     * to the contextChunks. Empty means "fully grounded".
     */
    ungroundedClaims: z.array(z.string()).default([]),
    /**
     * Verifier verdict, captured at write time so the UI can show a
     * confidence indicator without re-running the check.
     */
    grounding: z.enum(['GROUNDED', 'NOT_GROUNDED', 'NOT_VERIFIED']).default('NOT_VERIFIED'),
    /**
     * SBOM-grounded dependency identity, stamped server-side at persist time
     * for stack items only (never emitted by the model). Each entry ties the
     * stack name to its real `technology_evidence` version + canonical purl +
     * declaration file:line (migrations 089/090). Absent on non-stack signals
     * and on stack items with no code-dependency match.
     */
    verifiedTech: z.array(z.object({
        name:    z.string(),
        version: z.string().nullable(),
        purl:    z.string().nullable(),
        path:    z.string().nullable(),
        line:    z.number().int().nullable(),
    }).strict()).optional(),
}).strict();
export type SourceSignal = z.infer<typeof SourceSignalSchema>;

// ─── Case-study payload ─────────────────────────────────────────────────────

const StackItemSchema = z.object({
    category:       z.enum(STACK_CATEGORIES),
    name:           z.string().min(1).max(80),
    justification:  z.string().max(2000),
    /** Component name (looked up to id during persistence). */
    componentName:  z.string().max(80).optional(),
    sourceSignals:  SourceSignalSchema,
}).strict();
export type StackItem = z.infer<typeof StackItemSchema>;

const DecisionSchema = z.object({
    title:         z.string().min(1).max(200),
    context:       z.string().max(2000),
    decision:      z.string().max(2000),
    consequences:  z.string().max(2000),
    confidence:    z.enum(['high', 'medium', 'low']),
    sourceSignals: SourceSignalSchema,
}).strict();
export type Decision = z.infer<typeof DecisionSchema>;

const HighlightSchema = z.object({
    title:       z.string().min(1).max(200),
    description: z.string().min(1).max(2000),
    sourceSignals: SourceSignalSchema,
}).strict();
export type Highlight = z.infer<typeof HighlightSchema>;

const ChallengeSchema = z.object({
    problem:  z.string().min(1).max(2000),
    solution: z.string().min(1).max(2000),
    sourceSignals: SourceSignalSchema,
}).strict();
export type Challenge = z.infer<typeof ChallengeSchema>;

const ResumeBulletSetSchema = z.object({
    angle:   z.enum(RESUME_BULLET_ANGLES),
    bullets: z.array(z.string().min(1).max(500)).min(1).max(8),
}).strict();
export type ResumeBulletSet = z.infer<typeof ResumeBulletSetSchema>;

const DepthMarkersSchema = z.object({
    hasTests:              z.boolean(),
    testCoverageSignal:    z.enum(TEST_COVERAGE_SIGNALS),
    hasCi:                 z.boolean(),
    ciMaturity:            z.enum(CI_MATURITY),
    documentationDensity:  z.enum(DOC_DENSITY),
    hasDeploymentEvidence: z.boolean(),
    deploymentUrl:         z.string().url().nullable().optional(),
    refactorCount:         z.number().int().min(0),
}).strict();
export type DepthMarkers = z.infer<typeof DepthMarkersSchema>;

export const ArchitectureSchema = z.object({
    diagramFormat: z.enum(['mermaid', 'svg']),
    diagramSource: z.string().min(1),
    nodes: z.array(z.object({
        id:    z.string(),
        label: z.string(),
        kind:  z.enum(PROJECT_COMPONENT_KINDS),
    }).strict()).default([]),
    edges: z.array(z.object({
        from:  z.string(),
        to:    z.string(),
        label: z.string().optional(),
    }).strict()).default([]),
}).strict();
export type Architecture = z.infer<typeof ArchitectureSchema>;

export const CaseStudySchema = z.object({
    tagline: z.string().min(1).max(200),
    pitch:   z.string().min(1).max(4000),
    stack:        z.array(StackItemSchema).max(40),
    decisions:    z.array(DecisionSchema).max(5),
    highlights:   z.array(HighlightSchema).max(5),
    challenges:   z.array(ChallengeSchema).max(5),
    depthMarkers: DepthMarkersSchema,
    architecture: ArchitectureSchema,
    resumeBullets: z.array(ResumeBulletSetSchema)
        .min(1)
        .max(RESUME_BULLET_ANGLES.length),
}).strict();
export type CaseStudy = z.infer<typeof CaseStudySchema>;

/**
 * A project's existing case study, reconstructed from the DB for incremental
 * refinement. Carries each row's stored `sourceSignals` so the refine agent can
 * preserve already-grounded rows verbatim rather than re-deriving their
 * evidence. depthMarkers/architecture/resumeBullets are intentionally omitted —
 * the agent regenerates those holistically; they're not useful as scaffold.
 */
export type PriorCaseStudy = Pick<CaseStudy, 'tagline' | 'pitch' | 'stack' | 'decisions' | 'highlights' | 'challenges'>;

// ─── Per-project input context ──────────────────────────────────────────────

/**
 * The compact context passed to the case-study agent. Mirrors the same
 * "no raw blobs in the prompt" rule the clustering agent follows.
 */
export interface CaseStudyContext {
    readonly projectId:     string;
    readonly projectName:   string;
    readonly tagline:       string | null;
    readonly pitch:         string | null;
    readonly userOverrides: Record<string, unknown>;

    readonly components: ReadonlyArray<{
        readonly id:   string;
        readonly name: string;
        readonly kind: string;
    }>;

    readonly repositories: ReadonlyArray<{
        readonly id:               string;
        readonly fullName:         string;
        readonly primaryLanguage:  string | null;
        readonly topics:           readonly string[];
        readonly techStack:        readonly string[];
        readonly defaultBranch:    string | null;
    }>;

    /**
     * Recent commits across all member repos, capped by `MAX_COMMITS`
     * (default 50) per the orchestrator. Newest first.
     */
    readonly commits: ReadonlyArray<{
        readonly repoFullName: string;
        readonly sha:          string;
        readonly authoredAt:   string;
        readonly authorName:   string;
        readonly authorLogin?: string | null;
        readonly message:      string;
    }>;

    /**
     * Recent pull requests across member repos, capped by
     * `MAX_PULLS_PER_REPO` (default 25). Populated when the orchestrator
     * was given a `PullRequestLoader`. Absent for cases where the
     * adapter cannot reach the PR endpoint (e.g. forks with limited
     * token scope).
     */
    readonly pulls: ReadonlyArray<{
        readonly repoFullName: string;
        readonly number:       number;
        readonly title:        string;
        readonly body:         string | null;
        readonly state:        'open' | 'closed' | 'merged';
        readonly mergedAt:     string | null;
        readonly htmlUrl:      string;
        readonly authorLogin?: string | null;
    }>;

    /**
     * KB passages (description / highlight chunks already in the
     * embeddings table) shown to the model as context. The persistence
     * layer never reads from these — they're prompt-only.
     */
    readonly kbChunks: ReadonlyArray<{
        readonly repoFullName: string;
        readonly filePath:     string | null;
        readonly chunkType:    string;
        readonly content:      string;
    }>;

    // ── Product purpose (optional, additive) ─────────────────────────────
    // Ground-truth "what the product is / who it's for / what problem it
    // solves", assembled by the loader in precedence order: the user's
    // product_description override → repo descriptions → the root READMEs.
    // Fed to the agent as AUTHORITATIVE context: the pitch must open with it,
    // and it is EXEMPT from the commit-grounding rule (a given, not a claim).
    // Absent → the pitch falls back to today's code-only framing.
    readonly productContext?: string | null;

    // ── Archetype/stage calibration (optional, additive) ──────────────────
    // Populated by the loader when classification succeeds. Absent → the
    // agent prompt is unchanged (today's behavior).
    readonly archetype?:            { readonly id: string; readonly name: string } | null;
    readonly stage?:                'junior' | 'mid' | 'senior' | 'staff' | null;
    readonly prioritySections?:     readonly string[];
    readonly deemphasizedSections?: readonly string[];

    // ── Incremental refine (optional) ─────────────────────────────────────
    // When present, the agent runs in REFINE mode: it updates this prior case
    // study to reflect the project's current repositories/components instead of
    // writing from scratch. Attached by the orchestrator (post-pack). Absent →
    // today's full-generation behavior.
    readonly priorCaseStudy?: PriorCaseStudy | null;
    // Repos present in the project but not grounded by any prior row — the refine
    // agent is told to guarantee these get covered so a newly-added repo isn't
    // crowded out of the capped sections. Set by the orchestrator alongside
    // priorCaseStudy; empty/absent when the prior already covers every repo.
    readonly refineNewRepos?: readonly string[];

    // ── Code-grounded evidence (additive) ─────────────────────────────────
    // DepthMarkers computed deterministically from fileClass lane counts +
    // archetype signals (test/CI/deploy/docs maturity) — the orchestrator
    // OVERRIDES the model's depthMarkers with these so depth is measured, not
    // guessed. Absent → the model's own assessment stands.
    readonly depthMarkers?: DepthMarkers | null;
    // The most-changed files across member repos (from repo_commit_files diffs)
    // — real file-level evidence the agent can cite in sourceSignals.files for
    // challenges / highlights / decisions. Capped + newest-churn first.
    readonly fileChangeEvidence?: ReadonlyArray<{
        readonly repoFullName: string;
        readonly filePath:     string;
        readonly additions:    number;
        readonly deletions:    number;
        readonly changes:      number;
    }>;

    // ── SBOM-grounded stack (additive) ─────────────────────────────────────
    // The project's REAL code dependencies (technology_evidence: Syft/treesitter/
    // IaC/Docker lanes), one per canonical with its version + canonical purl.
    // Shown to the agent so the drafted stack reflects what the code actually
    // declares, not LLM-guessed tech tags. The persistence layer re-derives the
    // full map (with file:line) to stamp each stack item deterministically.
    readonly verifiedStack?: ReadonlyArray<{
        readonly name:    string;
        readonly version: string | null;
        readonly purl:    string | null;
    }>;
}
