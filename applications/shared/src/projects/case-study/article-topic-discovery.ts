/**
 * @format
 * Article topic discovery — a cheap transform of the case-study output into
 * narrow, problem-framed article candidates. Runs as a byproduct of case-study
 * generation: it reuses the already-synthesised `challenges` and `decisions`
 * (each already problem → resolution with cited evidence) and does NOT re-scan
 * or re-embed the repo.
 *
 * v1 boundary: candidates carry their evidence citations (commits/PRs/files) but
 * `verifiedMetrics` is left EMPTY here. Those numbers feed the Writer's
 * authoritative "you may cite these" block (Gap 3), so they are confirmed by the
 * admin in the builder (who knows the real measured values) rather than guessed
 * from prose — heuristic extraction would risk laundering a wrong number as
 * verified. A later Haiku enrichment pass can pre-fill them.
 */
import type { Pool } from 'pg';

import {
    ArticleTopicCandidateRepository,
    type ArticleTopicCandidateInput,
    type EvidenceRef,
} from '../../rds/implementations/ArticleTopicCandidateRepository.js';
import type { CaseStudy, SourceSignal } from './case-study-types.js';

/** The subset of a case study the discovery step reads. */
export type DiscoverySource = Pick<CaseStudy, 'challenges' | 'decisions'>;

export interface DeriveCandidatesInput {
    readonly userId:          string;
    readonly projectId:       string;
    readonly pipelineRunId?:  string;
    readonly caseStudy:       DiscoverySource;
    /** repo_full_name → github_repo_id (BIGINT as string). Repos absent here are skipped. */
    readonly repoIdByName:    ReadonlyMap<string, string>;
    /** The project's repos, used to attribute a candidate when its evidence names no repo. */
    readonly repoFullNames:   readonly string[];
}

const TITLE_MAX = 200;

/** Turn a problem statement into a concise, specific candidate title (display only — the Writer regenerates the real title). */
function synthesiseTitle(problem: string): string {
    const firstSentence = problem.split(/(?<=[.!?])\s/)[0] ?? problem;
    const trimmed = firstSentence.trim();
    return trimmed.length > TITLE_MAX ? `${trimmed.slice(0, TITLE_MAX - 1)}…` : trimmed;
}

/** Collect evidence citations from a case-study row's sourceSignals. */
function evidenceFromSignals(signals: SourceSignal): EvidenceRef[] {
    const refs: EvidenceRef[] = [];
    for (const c of signals.commits) refs.push({ type: 'commit', ref: c.sha });
    for (const p of signals.pulls)   refs.push({ type: 'pr', ref: `#${p.number}`, url: p.htmlUrl });
    for (const f of signals.files)   refs.push({ type: 'file', ref: f.path });
    return refs;
}

/** The repo a row is about: the first repo named by its evidence, else the project's sole/primary repo. */
function attributeRepo(signals: SourceSignal, repoFullNames: readonly string[]): string | undefined {
    const named =
        signals.commits[0]?.repoFullName ??
        signals.files[0]?.repoFullName ??
        signals.pulls[0]?.repoFullName;
    return named ?? repoFullNames[0];
}

/**
 * Pure transform: case-study challenges + decisions → topic candidates.
 * A candidate is emitted only when its repo resolves to a github_repo_id
 * (the candidate table requires it).
 */
export function buildCandidatesFromCaseStudy(input: DeriveCandidatesInput): ArticleTopicCandidateInput[] {
    const { userId, projectId, pipelineRunId, caseStudy, repoIdByName, repoFullNames } = input;
    const out: ArticleTopicCandidateInput[] = [];

    const push = (
        repoFullName: string | undefined,
        title: string,
        problem: string,
        angle: string | undefined,
        signals: SourceSignal,
    ): void => {
        if (!repoFullName) return;
        const githubRepoId = repoIdByName.get(repoFullName);
        if (!githubRepoId) return; // cannot key without a stable repo id
        out.push({
            userId,
            githubRepoId,
            repoFullName,
            projectId,
            sourcePipelineRunId: pipelineRunId,
            title,
            problem,
            angle,
            evidenceRefs: evidenceFromSignals(signals),
            verifiedMetrics: [], // admin-confirmed in the builder (see file header)
            skills: [],
        });
    };

    for (const c of caseStudy.challenges) {
        const repo = attributeRepo(c.sourceSignals, repoFullNames);
        push(repo, synthesiseTitle(c.problem), c.problem, c.solution.slice(0, TITLE_MAX), c.sourceSignals);
    }
    for (const d of caseStudy.decisions) {
        const repo = attributeRepo(d.sourceSignals, repoFullNames);
        push(repo, d.title, d.context, d.decision.slice(0, TITLE_MAX), d.sourceSignals);
    }

    return out;
}

/**
 * Resolve github_repo_ids for the project's repos, build candidates, and swap the
 * 'suggested' set per repo. Reuses the already-produced case study — no re-scan.
 * Returns the number of candidates written.
 */
export async function deriveArticleCandidates(
    pool: Pool,
    args: Omit<DeriveCandidatesInput, 'repoIdByName'>,
): Promise<number> {
    if (args.repoFullNames.length === 0) return 0;

    const res = await pool.query<{ full_name: string; github_repo_id: string }>(
        `SELECT full_name, github_repo_id::text AS github_repo_id
           FROM repositories
          WHERE user_id = $1 AND full_name = ANY($2::text[]) AND github_repo_id IS NOT NULL`,
        [args.userId, [...args.repoFullNames]],
    );
    const repoIdByName = new Map(res.rows.map((r) => [r.full_name, r.github_repo_id]));
    if (repoIdByName.size === 0) return 0;

    const candidates = buildCandidatesFromCaseStudy({ ...args, repoIdByName });
    if (candidates.length === 0) return 0;

    // Group by repo so each repo's 'suggested' set is swapped independently.
    const byRepo = new Map<string, ArticleTopicCandidateInput[]>();
    for (const c of candidates) {
        const list = byRepo.get(c.githubRepoId) ?? [];
        list.push(c);
        byRepo.set(c.githubRepoId, list);
    }

    const repo = new ArticleTopicCandidateRepository(pool);
    for (const [githubRepoId, list] of byRepo) {
        await repo.replaceSuggestedForRepo(args.userId, githubRepoId, list);
    }
    return candidates.length;
}
