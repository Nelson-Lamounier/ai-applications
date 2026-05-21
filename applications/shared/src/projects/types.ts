/**
 * @format
 * Shared types + Zod schemas for the Projects multi-repo domain.
 *
 * Phase 2A introduces the clustering shapes. Future phases extend this
 * file with case-study, architecture, and resume-bullets shapes.
 */
import { z } from 'zod';

// ─── Component kinds (mirror migrations/030_projects.sql) ──────────────────
export const PROJECT_COMPONENT_KINDS = [
    'frontend', 'backend', 'infra', 'mobile',
    'data', 'ml', 'docs', 'shared',
] as const;
export type ProjectComponentKind = (typeof PROJECT_COMPONENT_KINDS)[number];

export const ProjectComponentKindSchema = z.enum(PROJECT_COMPONENT_KINDS);

// ─── Clustering output ──────────────────────────────────────────────────────

/**
 * One component of a proposed project. Each component groups one or more
 * repositories that share a role (frontend / backend / infra / etc.).
 */
export const ClusteringComponentSchema = z.object({
    name:           z.string().min(1).max(80),
    kind:           ProjectComponentKindSchema,
    repositoryIds:  z.array(z.string().uuid()).min(1),
}).strict();
export type ClusteringComponent = z.infer<typeof ClusteringComponentSchema>;

/**
 * One proposed multi-repo project. Single-repo proposals are not emitted by
 * the agent — they remain as the default backfilled projects from migration
 * 031. Confidence + reasoning are surfaced to the user in the review UI.
 */
export const ClusteringProposalSchema = z.object({
    name:        z.string().min(1).max(120),
    confidence:  z.enum(['high', 'medium', 'low']),
    reasoning:   z.string().min(1).max(2000),
    components:  z.array(ClusteringComponentSchema).min(1),
}).strict();
export type ClusteringProposal = z.infer<typeof ClusteringProposalSchema>;

/**
 * Top-level output. Capped at 8 proposals per spec §Phase 2 Service 1; the
 * model is instructed in the system prompt to drop low-signal groupings if
 * it would otherwise exceed the cap.
 */
export const ClusteringResultSchema = z.object({
    proposals: z.array(ClusteringProposalSchema).max(8),
}).strict();
export type ClusteringResult = z.infer<typeof ClusteringResultSchema>;

// ─── Signals fed to the clustering agent ────────────────────────────────────

/**
 * Compact, deterministic per-repo summary built before the model is invoked.
 * The model never receives raw repo content — only this digest. Keeping the
 * digest small (<1KB per repo) is what lets clustering run on Haiku 4.5
 * within sensible token budgets.
 */
export interface RepoClusteringDigest {
    /** Repository UUID — what the model references in `repositoryIds`. */
    readonly repositoryId:     string;
    /** `owner/repo`. */
    readonly fullName:         string;
    /** Short repo name (last path segment of fullName). */
    readonly shortName:        string;
    /** GitHub primary language (may be null). */
    readonly primaryLanguage:  string | null;
    /** GitHub-set topics. */
    readonly topics:           readonly string[];
    /** First date we observed activity for this repo. */
    readonly firstSeenAt:      string | null;
    /** Most-recent indexed timestamp. */
    readonly lastSyncedAt:     string | null;
    /** Profile-extracted tech stack (best-effort). */
    readonly techStack:        readonly string[];
    /** Best-guess shape — single_repo unless we already merged it. */
    readonly classification:   string | null;
}

/**
 * Deterministic signal block computed once, passed alongside the digests so
 * the model can lean on pre-computed correlations rather than re-discovering
 * them. All values are derived from existing tables — no extra GitHub
 * fetches required to run clustering today.
 */
export interface ClusteringSignals {
    /**
     * Naming prefixes that span ≥ 2 repos. e.g. for
     * [`tucaken-api`, `tucaken-web`, `notes`] this yields
     * `{ tucaken: ['tucaken-api', 'tucaken-web'] }`.
     */
    readonly namingPrefixes: ReadonlyMap<string, readonly string[]>;
    /**
     * Topics that span ≥ 2 repos, with the repos that share each topic.
     * Filters out generic tags like `typescript` / `python` via a tiny
     * blocklist so they don't dominate signal.
     */
    readonly sharedTopics: ReadonlyMap<string, readonly string[]>;
    /**
     * Tech-stack overlaps that span ≥ 2 repos, mined from
     * `repository_profiles.extracted->'tech_stack'`.
     */
    readonly sharedTechStack: ReadonlyMap<string, readonly string[]>;
    /**
     * Symmetric, embedding-cosine pairs above the threshold (default 0.78
     * over Titan v2). `(repoFullNameA, repoFullNameB, score)`. Ordered by
     * descending score; capped at 32 pairs to keep the prompt compact.
     */
    readonly embeddingPairs: ReadonlyArray<{
        readonly repoA: string;
        readonly repoB: string;
        readonly score: number;
    }>;
}
