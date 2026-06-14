/**
 * @format
 * Reconstruct a project's existing case study from the DB so the case-study
 * agent can REFINE it (incrementally) instead of regenerating from scratch.
 *
 * Why reconstruct rather than just pass the new repo's commits: every case-study
 * row must cite `sourceSignals` (commits / pulls / files). The prior rows were
 * grounded against commits that may not be in the current prompt window, so we
 * reload each row WITH its stored `source_signals` — the agent preserves
 * still-accurate rows (and their evidence) verbatim and only mints new rows from
 * the fresh evidence it is given.
 *
 * Returns null when there is nothing to refine (no completed case study yet),
 * so the caller falls back to full generation.
 */
import type { Pool } from 'pg';

import type { PriorCaseStudy } from './case-study-types.js';
import type { SourceSignal } from './case-study-types.js';

const EMPTY_SIGNAL: SourceSignal = {
    commits: [], pulls: [], files: [], ungroundedClaims: [], grounding: 'NOT_VERIFIED',
};

/** Coerce a JSONB source_signals cell into a SourceSignal, tolerating partial/legacy shapes. */
function asSignal(raw: unknown): SourceSignal {
    if (!raw || typeof raw !== 'object') return EMPTY_SIGNAL;
    const r = raw as Record<string, unknown>;
    return {
        commits: Array.isArray(r.commits) ? (r.commits as SourceSignal['commits']) : [],
        pulls:   Array.isArray(r.pulls)   ? (r.pulls as SourceSignal['pulls'])     : [],
        files:   Array.isArray(r.files)   ? (r.files as SourceSignal['files'])     : [],
        ungroundedClaims: Array.isArray(r.ungroundedClaims) ? (r.ungroundedClaims as string[]) : [],
        grounding: r.grounding === 'GROUNDED' || r.grounding === 'NOT_GROUNDED' ? r.grounding : 'NOT_VERIFIED',
    };
}

export async function reconstructPriorCaseStudy(
    pool: Pool,
    projectId: string,
): Promise<PriorCaseStudy | null> {
    const projectRes = await pool.query<{ tagline: string | null; pitch: string | null; case_study_generated_at: Date | string | null }>(
        `SELECT tagline, pitch, case_study_generated_at FROM projects WHERE id = $1`,
        [projectId],
    );
    const project = projectRes.rows[0];
    // Refine only a project that has completed a case study at least once. We
    // gate on `case_study_generated_at` (set on first completion) rather than
    // `case_study_status`, because the regenerate/confirm endpoints flip status
    // to 'pending' BEFORE dispatching this job — gating on status would wrongly
    // fall back to a full rewrite every time the user clicks Regenerate.
    if (!project || project.case_study_generated_at == null) return null;

    const [decisions, highlights, challenges, stack] = await Promise.all([
        pool.query<{ title: string; context: string | null; decision: string | null; consequences: string | null; confidence: string | null; source_signals: unknown }>(
            `SELECT title, context, decision, consequences, confidence, source_signals
               FROM project_decisions WHERE project_id = $1 ORDER BY order_index`,
            [projectId],
        ),
        pool.query<{ title: string; description: string | null; source_signals: unknown }>(
            `SELECT title, description, source_signals
               FROM project_highlights WHERE project_id = $1 ORDER BY order_index`,
            [projectId],
        ),
        pool.query<{ problem: string; solution: string | null; source_signals: unknown }>(
            `SELECT problem, solution, source_signals
               FROM project_challenges WHERE project_id = $1 ORDER BY order_index`,
            [projectId],
        ),
        pool.query<{ category: string; name: string; justification: string | null; source_signals: unknown }>(
            `SELECT category, name, justification, source_signals
               FROM project_stack_items WHERE project_id = $1 ORDER BY order_index`,
            [projectId],
        ),
    ]);

    const prior: PriorCaseStudy = {
        tagline: project.tagline ?? '',
        pitch:   project.pitch ?? '',
        decisions: decisions.rows.map((r) => ({
            title:        r.title,
            context:      r.context ?? '',
            decision:     r.decision ?? '',
            consequences: r.consequences ?? '',
            confidence:   (r.confidence === 'high' || r.confidence === 'low' ? r.confidence : 'medium'),
            sourceSignals: asSignal(r.source_signals),
        })),
        highlights: highlights.rows.map((r) => ({
            title:       r.title,
            description: r.description ?? '',
            sourceSignals: asSignal(r.source_signals),
        })),
        challenges: challenges.rows.map((r) => ({
            problem:  r.problem,
            solution: r.solution ?? '',
            sourceSignals: asSignal(r.source_signals),
        })),
        stack: stack.rows.map((r) => ({
            category: r.category as PriorCaseStudy['stack'][number]['category'],
            name:     r.name,
            justification: r.justification ?? '',
            sourceSignals: asSignal(r.source_signals),
        })),
    };

    // Nothing meaningful to scaffold from → let the caller do a full generation.
    const isEmpty =
        prior.decisions.length === 0 &&
        prior.highlights.length === 0 &&
        prior.challenges.length === 0 &&
        prior.stack.length === 0;
    return isEmpty ? null : prior;
}
