/**
 * @format
 * repo-role-signals — load the code-grounded signals that drive component-kind
 * classification, for every repo a user owns.
 *
 * Joins the archetype map + evidence topology (repo_sync_state) and the
 * fileClass lane counts (document_embeddings) onto each repository, plus tech
 * stack / topics / primary language. The row→signals mapping is pure (tested);
 * the query is a thin wrapper.
 */

import type { Pool } from 'pg';

import type { RepoRoleSignals } from './component-kind.js';

/** Raw row shape returned by the role-signals query. */
export interface RoleSignalsRow {
    repository_id:     string;
    primary_language:  string | null;
    topics:            string[] | null;
    tech_stack:        string[] | null;
    archetype_signals: Record<string, unknown> | null;
    evidence_topology: Record<string, unknown> | null;
    file_class_counts: Record<string, number> | null;
}

const ARCHETYPE_KEYS = [
    'has_iac', 'has_k8s_manifests', 'has_helm_chart', 'has_argocd_apps', 'has_dockerfile', 'has_ci',
    'has_android_dir', 'has_ios_dir', 'has_react_native', 'has_flutter_pubspec',
    'has_models_dir', 'has_requirements_with_ml_deps', 'has_notebooks',
] as const;

function bool(v: unknown): boolean {
    return v === true || v === 'true';
}
function numOf(v: unknown): number {
    const n = typeof v === 'string' ? Number(v) : (v as number);
    return Number.isFinite(n) ? n : 0;
}

/** Pure: project a raw row into the RepoRoleSignals the classifier consumes. */
export function extractRoleSignals(row: RoleSignalsRow): RepoRoleSignals {
    const a = row.archetype_signals ?? {};
    const archetype: Record<string, boolean> = {};
    for (const k of ARCHETYPE_KEYS) archetype[k] = bool(a[k]);

    const e = row.evidence_topology ?? {};
    const migrationTools = Array.isArray(e['migration_tools']) ? (e['migration_tools'] as string[]) : [];

    const fc = row.file_class_counts ?? {};
    const fileClassCounts = {
        source: numOf(fc['source']), iac: numOf(fc['iac']), ci: numOf(fc['ci']),
        test: numOf(fc['test']), db: numOf(fc['db']), docs: numOf(fc['docs']), config: numOf(fc['config']),
    };

    return {
        primaryLanguage: row.primary_language,
        techStack:       row.tech_stack ?? [],
        topics:          row.topics ?? [],
        archetype,
        evidence: {
            is_monorepo:     bool(e['is_monorepo']),
            has_migrations:  bool(e['has_migrations']),
            migration_tools: migrationTools,
        },
        fileClassCounts,
    };
}

/** Load grounded role signals for every repo the user owns, keyed by repository id. */
export async function loadRepoRoleSignals(pool: Pool, userId: string): Promise<Map<string, RepoRoleSignals>> {
    const r = await pool.query<RoleSignalsRow>(
        `SELECT
            r.id              AS repository_id,
            r.primary_language AS primary_language,
            r.topics           AS topics,
            COALESCE(ARRAY(
                SELECT jsonb_array_elements_text(COALESCE(rp.extracted -> 'tech_stack', '[]'::jsonb))
            ), '{}'::text[]) AS tech_stack,
            s.archetype_signals AS archetype_signals,
            s.evidence_topology AS evidence_topology,
            (
                SELECT jsonb_object_agg(fc, cnt) FROM (
                    SELECT d.metadata->>'fileClass' AS fc, count(*) AS cnt
                    FROM document_embeddings d
                    WHERE d.user_id = r.user_id
                      AND d.repo_full_name = r.full_name
                      AND d.metadata->>'fileClass' IS NOT NULL
                    GROUP BY d.metadata->>'fileClass'
                ) t
            ) AS file_class_counts
         FROM repositories r
         LEFT JOIN repository_profiles rp ON rp.user_id = r.user_id AND rp.repo_full_name = r.full_name
         LEFT JOIN repo_sync_state    s  ON s.user_id  = r.user_id AND s.repo_full_name  = r.full_name
         WHERE r.user_id = $1`,
        [userId],
    );

    const out = new Map<string, RepoRoleSignals>();
    for (const row of r.rows) out.set(row.repository_id, extractRoleSignals(row));
    return out;
}
