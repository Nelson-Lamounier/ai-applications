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
 * P2: detector-backed first, signal-derived as a fallback. `deriveConcepts`
 * loads `concept_evidence` (migration 123, `ConceptPatternExtractor` /
 * `runConceptLane` in `run-facts-stage.ts`) joined to `skill_ontology`,
 * grouped by (canonical name, detector) — each row becomes one `ConceptEntry`
 * with a real `files` count, and a concept may carry more than one entry when
 * more than one detector fired for it. The pre-P2 signal-derived concepts
 * (below) remain, but ONLY for a concept name with zero detector rows —
 * those entries keep `detector: 'signal'`, `files: 0` as before, straight off
 * `RepoRoleSignals` plus one extra raw flag, `has_monitoring_config`, which
 * ships in the broader `repo_sync_state.archetype_signals` JSONB
 * (`applications/shared/src/projects/evidence/repo-signals.ts`) but isn't
 * part of the narrower `RepoRoleSignals.archetype` shape that
 * `loadRepoRoleSignals` exposes for kind classification — so it's read
 * directly off `repo_sync_state` in `buildRepoFacts` and threaded into
 * `assembleRepoFacts` as a separate input:
 *
 *   has_ci                                                 -> "ci/cd pipelines"
 *   has_k8s_manifests || has_helm_chart || has_argocd_apps  -> "container orchestration"
 *   has_iac                                                 -> "infrastructure as code"
 *   has_monitoring_config                                   -> "observability"
 *   evidence_topology.has_migrations                        -> "database migrations"
 *
 * Note: the signal-derived name for the CI concept is `'ci/cd pipelines'`,
 * matching the concept-detector canonical (migration 123's `skill_ontology`
 * seed) exactly — a repo with both CI signals and detector-confirmed
 * workflow files never carries a divergent `'ci/cd'` / `'ci/cd pipelines'`
 * pair; `deriveConcepts`'s `detectorNames` dedup collapses them into the one
 * detector-backed entry, as intended.
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
 * One repo concept entry. `detector` is either a real detector name
 * (`'workflow-ci'`, `'monitoring-config'`, ...) with a real `files` count
 * when backed by `concept_evidence`, or the legacy `'signal'` / `0` pair when
 * it is a fallback derived purely from `RepoRoleSignals` (no detector rows
 * exist yet for that concept). See the module header "concepts" section.
 */
export interface ConceptEntry {
    readonly name: string;
    readonly detector: string;
    readonly files: number;
}

/** One aggregated `concept_evidence` row: one per (canonical concept, detector). */
export interface ConceptDetectorRow {
    readonly name: string; // skill_ontology.canonical_name
    readonly detector: string;
    readonly files: number;
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
    /** Aggregated `concept_evidence` rows for this repo (empty when the concept lane has never run for it). */
    readonly conceptRows: readonly ConceptDetectorRow[];
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

/**
 * See the module header "concepts" section. Detector-backed rows always win:
 * every `conceptRows` entry becomes a `ConceptEntry` as-is (one per detector
 * per concept). The signal-derived fallback entries are then appended, but
 * ONLY for a concept name that has zero detector rows — a concept name
 * covered by at least one detector row never also gets a `'signal'` entry.
 */
function deriveConcepts(
    signals: RepoRoleSignals, hasMonitoringConfig: boolean, conceptRows: readonly ConceptDetectorRow[],
): ConceptEntry[] {
    const detectorEntries: ConceptEntry[] = conceptRows.map((row) => (
        { name: row.name, detector: row.detector, files: row.files }
    ));
    const detectorNames = new Set(detectorEntries.map((entry) => entry.name));

    const signalFallback: ConceptEntry[] = [];
    const archetype = signals.archetype;
    if (archetype.has_ci) signalFallback.push(concept('ci/cd pipelines'));
    if (archetype.has_k8s_manifests || archetype.has_helm_chart || archetype.has_argocd_apps) {
        signalFallback.push(concept('container orchestration'));
    }
    if (archetype.has_iac) signalFallback.push(concept('infrastructure as code'));
    if (hasMonitoringConfig) signalFallback.push(concept('observability'));
    if (signals.evidence.has_migrations) signalFallback.push(concept('database migrations'));

    return [...detectorEntries, ...signalFallback.filter((entry) => !detectorNames.has(entry.name))];
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
    const concepts = deriveConcepts(inputs.signals, inputs.hasMonitoringConfig, inputs.conceptRows);

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

async function loadConceptRows(pool: Pool, userId: string, repoFullName: string): Promise<ConceptDetectorRow[]> {
    const { rows } = await pool.query<{ canonical_name: string; detector: string; files: string | number }>(
        `SELECT so.canonical_name, ce.detector, count(*) AS files
           FROM concept_evidence ce
           JOIN skill_ontology so ON so.id = ce.skill_id
          WHERE ce.user_id = $1 AND ce.repo_full_name = $2
          GROUP BY 1, 2`,
        [userId, repoFullName],
    );
    return rows.map((row) => ({ name: row.canonical_name, detector: row.detector, files: Number(row.files) }));
}

const FACT_VERSION = 1;

/**
 * Per-repo assembly + upsert, given an already-loaded role-signals map (see
 * `buildRepoFactsBatch`). Throws on a missing repository row / missing role
 * signals / DB error — callers decide whether that is fatal (single-repo
 * `buildRepoFacts`) or isolated (`buildRepoFactsBatch`'s per-repo try/catch).
 */
async function buildOneRepoFacts(
    pool: Pool, userId: string, repoFullName: string, signalsMap: Map<string, RepoRoleSignals>,
): Promise<void> {
    const repoRow = await loadRepoRow(pool, userId, repoFullName);
    if (!repoRow) {
        throw new Error(`repo_facts: repository not found for user ${userId} / ${repoFullName}`);
    }

    const [techRows, conceptRows] = await Promise.all([
        loadTechRows(pool, userId, repoFullName),
        loadConceptRows(pool, userId, repoFullName),
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
        conceptRows,
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

export interface BuildRepoFactsBatchResult {
    readonly succeeded: number;
    readonly failed:    number;
}

/**
 * Batch orchestration: loads `loadRepoRoleSignals` ONCE for the whole user
 * (a single query returning every repo's signals) instead of once per repo —
 * the single-repo `buildRepoFacts` below re-ran that same user-wide query for
 * every repo when looped by the backfill runner. Assembles + upserts each
 * repo's fact sheet with its OWN try/catch so one repo's failure never
 * aborts the rest of the batch.
 *
 * `onRepoError`, when provided, receives the raw per-repo error (repo full
 * name + the thrown error) — used by `buildRepoFacts` below to recover and
 * rethrow the original error for its single-repo throw-on-failure contract,
 * and by the backfill runner to log a warning per failed repo.
 */
export async function buildRepoFactsBatch(
    pool: Pool, userId: string, repoFullNames: readonly string[],
    onRepoError?: (repoFullName: string, err: unknown) => void,
): Promise<BuildRepoFactsBatchResult> {
    const signalsMap = await loadRepoRoleSignals(pool, userId);

    let succeeded = 0;
    let failed = 0;
    for (const repoFullName of repoFullNames) {
        try {
            await buildOneRepoFacts(pool, userId, repoFullName, signalsMap);
            succeeded += 1;
        } catch (err) {
            failed += 1;
            onRepoError?.(repoFullName, err);
        }
    }
    return { succeeded, failed };
}

/**
 * Orchestration: single-repo entrypoint. Delegates to `buildRepoFactsBatch`
 * with a one-element array, then rethrows the original per-repo error (via
 * `onRepoError`) when it failed — preserving the historical throw-on-failure
 * contract (missing repository row / missing role signals / DB error). Both
 * callers (the run-ingestion hook and, historically, the backfill runner —
 * now `buildRepoFactsBatch` directly) wrap this in their own try/catch and
 * treat it as best-effort, never fatal.
 */
export async function buildRepoFacts(pool: Pool, userId: string, repoFullName: string): Promise<void> {
    let thrown: unknown;
    const { succeeded } = await buildRepoFactsBatch(pool, userId, [repoFullName], (_repo, err) => { thrown = err; });
    if (succeeded === 0) throw thrown;
}
