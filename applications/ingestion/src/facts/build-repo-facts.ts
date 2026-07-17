/**
 * @format
 * build-repo-facts — assembles + persists the per-repo `repo_facts`
 * materialised fact sheet (migration 121, spec P0 UC1/UC2). One row per
 * (user_id, repo_full_name): a small, cheap-to-read JSONB summary of what a
 * repo IS — languages/frameworks/databases/infrastructure/tools with
 * per-technology evidence counts, plus a handful of signal-derived
 * "concepts" — so downstream consumers (case-study generation, project
 * synthesis) don't have to re-query `technology_evidence` + `repo_sync_state`
 * on every read.
 *
 * ── Category -> lane mapping ────────────────────────────────────────────────
 * `technology_ontology.category` (the 30-value CHECK constraint from
 * migrations 034 + 036) maps onto the five `repo_facts` lanes as follows.
 * Every category currently in the CHECK constraint is accounted for; a
 * category added later that isn't in `CATEGORY_LANE` falls through to
 * `tools` (the catch-all) rather than being silently dropped.
 *
 *   languages       language
 *   frameworks      framework_web, framework_mobile, framework_ml
 *   databases       database_relational, database_nosql, database_vector,
 *                   database_search, database_kv
 *   infrastructure  iac, orchestration, container_runtime, cloud_compute,
 *                   cloud_storage, cloud_database, cloud_serverless,
 *                   cloud_networking, cloud_security, message_broker
 *   tools           ci_cd, build_tool, testing, package_manager,
 *                   developer_tool, api_protocol, auth, payment, runtime,
 *                   ai_platform, observability (catch-all; also home for any
 *                   future category not listed above)
 *
 * Two placements read as surprising at a glance, called out explicitly:
 * `message_broker` -> infrastructure (a broker is platform plumbing, not an
 * app-level tool, so it sits with orchestration/cloud); `runtime` and
 * `ai_platform` -> tools (a language runtime or an AI-platform SDK is neither
 * a language nor deployed infrastructure).
 *
 * `languages` also always includes `repositories.primary_language` (GitHub's
 * linguist verdict) even when `technology_evidence` has no `language`-category
 * row for it yet, so the lane is never empty for a repo GitHub can classify.
 *
 * ── version selection ───────────────────────────────────────────────────────
 * Only the Syft lane populates `technology_evidence.version` (migration 090);
 * treesitter/iac/dockerfile leave it NULL. Aggregated rows have no natural
 * "first" ordering (a GROUP BY has no stable row order), so "first non-null
 * wins" is implemented as `MAX(version) FILTER (WHERE version IS NOT NULL)` —
 * a deterministic pick rather than one dependent on arbitrary row order.
 *
 * ── concepts ─────────────────────────────────────────────────────────────────
 * Signal-derived only (no LLM, no file-content detectors yet — that's a later
 * phase). Each concept fires straight off `RepoRoleSignals` plus one extra
 * raw flag, `has_monitoring_config`, which ships in the broader
 * `repo_sync_state.archetype_signals` JSONB
 * (`applications/shared/src/projects/evidence/repo-signals.ts`) but isn't
 * part of the narrower `RepoRoleSignals.archetype` shape that
 * `loadRepoRoleSignals` exposes for kind classification — so it's read
 * directly off `repo_sync_state` in `buildRepoFacts` and threaded into
 * `assembleRepoFacts` as a separate input:
 *
 *   has_ci                                                 -> "ci/cd"
 *   has_k8s_manifests || has_helm_chart || has_argocd_apps  -> "container orchestration"
 *   has_iac                                                 -> "infrastructure as code"
 *   has_monitoring_config                                   -> "observability"
 *   evidence_topology.has_migrations                        -> "database migrations"
 */

import type { Pool } from 'pg';
import {
    loadRepoRoleSignals,
    classifyComponentKind,
} from '@bedrock/shared';
import type { RepoRoleSignals, ProjectComponentKind } from '@bedrock/shared';

import { RepoFactsRepository } from '../persistence/RepoFactsRepository.js';

/** One technology entry within a lane. */
export interface FactEntry {
    readonly name: string;
    readonly version: string | null;
    readonly evidenceCount: number;
}

/**
 * One signal-derived concept. `detector` is always `'signal'` and `files` is
 * always `0` for this phase — reserved fields for a future file-count /
 * content-detector lane (spec P1+), kept in the shape now so consumers don't
 * need a schema migration when that lane ships.
 */
export interface ConceptEntry {
    readonly name: string;
    readonly detector: 'signal';
    readonly files: 0;
}

/** The `repo_facts.facts` JSONB payload. */
export interface RepoFactsPayload {
    readonly languages: FactEntry[];
    readonly frameworks: FactEntry[];
    readonly databases: FactEntry[];
    readonly infrastructure: FactEntry[];
    readonly tools: FactEntry[];
    readonly concepts: ConceptEntry[];
}

type Lane = 'languages' | 'frameworks' | 'databases' | 'infrastructure' | 'tools';

/** See the module header for the full mapping rationale. */
const CATEGORY_LANE: Readonly<Record<string, Lane>> = {
    language: 'languages',

    framework_web:    'frameworks',
    framework_mobile: 'frameworks',
    framework_ml:     'frameworks',

    database_relational: 'databases',
    database_nosql:      'databases',
    database_vector:     'databases',
    database_search:     'databases',
    database_kv:         'databases',

    iac:                'infrastructure',
    orchestration:      'infrastructure',
    container_runtime:  'infrastructure',
    cloud_compute:      'infrastructure',
    cloud_storage:      'infrastructure',
    cloud_database:     'infrastructure',
    cloud_serverless:   'infrastructure',
    cloud_networking:   'infrastructure',
    cloud_security:     'infrastructure',
    message_broker:     'infrastructure',

    ci_cd:            'tools',
    build_tool:       'tools',
    testing:          'tools',
    package_manager:  'tools',
    developer_tool:   'tools',
    api_protocol:     'tools',
    auth:             'tools',
    payment:          'tools',
    runtime:          'tools',
    ai_platform:      'tools',
    observability:    'tools',
};

/** Aggregated `technology_evidence` row: one per (canonical technology, category). */
export interface TechEvidenceRow {
    readonly name: string; // lower(technology_ontology.canonical_name)
    readonly category: string;
    readonly version: string | null;
    readonly evidenceCount: number;
}

/** Pure-assembler inputs. */
export interface RepoFactsInputs {
    readonly techRows: readonly TechEvidenceRow[];
    readonly primaryLanguage: string | null;
    readonly signals: RepoRoleSignals;
    /** repo_sync_state.archetype_signals->>'has_monitoring_config'; see header. */
    readonly hasMonitoringConfig: boolean;
}

function concept(name: string): ConceptEntry {
    return { name, detector: 'signal', files: 0 };
}

/**
 * Merge a tech-evidence row into its lane, deduping on `name`. The
 * per-repo tech-evidence query already GROUPs BY (canonical name, category)
 * so duplicates should not occur in practice — this merge is a defensive
 * second guarantee of "first non-null version wins, evidence counts sum" so
 * `assembleRepoFacts` stays correct even if a caller hands it un-aggregated
 * rows.
 */
function mergeInto(lane: FactEntry[], row: TechEvidenceRow): void {
    const index = lane.findIndex((entry) => entry.name === row.name);
    if (index === -1) {
        lane.push({ name: row.name, version: row.version, evidenceCount: row.evidenceCount });
        return;
    }
    const existing = lane[index];
    lane[index] = {
        name:          existing.name,
        version:       existing.version ?? row.version,
        evidenceCount: existing.evidenceCount + row.evidenceCount,
    };
}

/**
 * Pure: fold aggregated tech-evidence rows + role signals into the
 * `repo_facts.facts` JSONB shape. No I/O — fully unit-testable.
 */
function foldInPrimaryLanguage(languages: FactEntry[], primaryLanguage: string | null): void {
    if (!primaryLanguage) return;
    const lowered = primaryLanguage.toLowerCase();
    if (!languages.some((entry) => entry.name === lowered)) {
        languages.push({ name: lowered, version: null, evidenceCount: 0 });
    }
}

/** See the module header "concepts" section for the full signal -> concept table. */
function deriveConcepts(signals: RepoRoleSignals, hasMonitoringConfig: boolean): ConceptEntry[] {
    const concepts: ConceptEntry[] = [];
    const archetype = signals.archetype;
    if (archetype.has_ci) concepts.push(concept('ci/cd'));
    if (archetype.has_k8s_manifests || archetype.has_helm_chart || archetype.has_argocd_apps) {
        concepts.push(concept('container orchestration'));
    }
    if (archetype.has_iac) concepts.push(concept('infrastructure as code'));
    if (hasMonitoringConfig) concepts.push(concept('observability'));
    if (signals.evidence.has_migrations) concepts.push(concept('database migrations'));
    return concepts;
}

export function assembleRepoFacts(inputs: RepoFactsInputs): RepoFactsPayload {
    const languages: FactEntry[] = [];
    const frameworks: FactEntry[] = [];
    const databases: FactEntry[] = [];
    const infrastructure: FactEntry[] = [];
    const tools: FactEntry[] = [];
    const lanes: Record<Lane, FactEntry[]> = { languages, frameworks, databases, infrastructure, tools };

    for (const row of inputs.techRows) {
        const lane = CATEGORY_LANE[row.category] ?? 'tools';
        mergeInto(lanes[lane], row);
    }

    foldInPrimaryLanguage(languages, inputs.primaryLanguage);
    const concepts = deriveConcepts(inputs.signals, inputs.hasMonitoringConfig);

    return { languages, frameworks, databases, infrastructure, tools, concepts };
}

// ── Orchestration (I/O) ─────────────────────────────────────────────────────

interface RepoRow {
    repositoryId:        string;
    githubRepoId:        number | null;
    primaryLanguage:     string | null;
    classification:      string | null;
    hasMonitoringConfig: boolean;
}

async function loadRepoRow(pool: Pool, userId: string, repoFullName: string): Promise<RepoRow | null> {
    const { rows } = await pool.query<{
        repository_id:         string;
        github_repo_id:        string | null;
        primary_language:      string | null;
        classification:        string | null;
        has_monitoring_config: boolean | null;
    }>(
        `SELECT
            r.id                AS repository_id,
            r.github_repo_id    AS github_repo_id,
            r.primary_language  AS primary_language,
            rp.classification   AS classification,
            COALESCE((s.archetype_signals ->> 'has_monitoring_config')::boolean, false) AS has_monitoring_config
         FROM repositories r
         LEFT JOIN repository_profiles rp ON rp.user_id = r.user_id AND rp.repo_full_name = r.full_name
         LEFT JOIN repo_sync_state     s  ON s.user_id  = r.user_id AND s.repo_full_name  = r.full_name
         WHERE r.user_id = $1 AND r.full_name = $2
         LIMIT 1`,
        [userId, repoFullName],
    );
    const row = rows[0];
    if (!row) return null;
    return {
        repositoryId:        row.repository_id,
        githubRepoId:        row.github_repo_id == null ? null : Number(row.github_repo_id),
        primaryLanguage:     row.primary_language,
        classification:      row.classification,
        hasMonitoringConfig: row.has_monitoring_config === true,
    };
}

async function loadTechRows(pool: Pool, userId: string, repoFullName: string): Promise<TechEvidenceRow[]> {
    const { rows } = await pool.query<{
        name:            string;
        category:        string;
        version:         string | null;
        evidence_count:  number;
    }>(
        `SELECT
            lower(o.canonical_name)                                AS name,
            o.category                                             AS category,
            max(te.version) FILTER (WHERE te.version IS NOT NULL)  AS version,
            count(*)::int                                          AS evidence_count
         FROM technology_evidence te
         JOIN technology_ontology o ON o.id = te.technology_id
         WHERE te.user_id = $1
           AND te.repo_full_name = $2
           AND te.source_layer = ANY(ARRAY['syft','treesitter','iac','dockerfile'])
         GROUP BY 1, 2`,
        [userId, repoFullName],
    );
    return rows.map((row) => ({
        name:          row.name,
        category:      row.category,
        version:       row.version,
        evidenceCount: Number(row.evidence_count),
    }));
}

const FACT_VERSION = 1;

/**
 * Orchestration: load inputs (repo + repository_profiles + repo_sync_state +
 * aggregated technology_evidence + role signals), classify the repo's
 * component kind, assemble the fact sheet, and upsert it.
 *
 * Throws on a missing repository row / missing role signals / DB error —
 * both callers (the run-ingestion hook and the backfill runner) wrap this in
 * their own try/catch and treat it as best-effort, never fatal.
 */
export async function buildRepoFacts(pool: Pool, userId: string, repoFullName: string): Promise<void> {
    const repoRow = await loadRepoRow(pool, userId, repoFullName);
    if (!repoRow) {
        throw new Error(`repo_facts: repository not found for user ${userId} / ${repoFullName}`);
    }

    const [techRows, signalsMap] = await Promise.all([
        loadTechRows(pool, userId, repoFullName),
        loadRepoRoleSignals(pool, userId),
    ]);

    const signals = signalsMap.get(repoRow.repositoryId);
    if (!signals) {
        throw new Error(`repo_facts: no role signals for repository ${repoRow.repositoryId} (${repoFullName})`);
    }

    const role: ProjectComponentKind = classifyComponentKind(signals);
    const facts = assembleRepoFacts({
        techRows,
        primaryLanguage:     repoRow.primaryLanguage,
        signals,
        hasMonitoringConfig: repoRow.hasMonitoringConfig,
    });

    const repository = new RepoFactsRepository(pool);
    await repository.upsert(userId, repoFullName, {
        githubRepoId:   repoRow.githubRepoId,
        role,
        classification: repoRow.classification,
        facts,
        factVersion:    FACT_VERSION,
    });
}
