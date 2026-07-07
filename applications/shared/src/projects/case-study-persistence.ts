/**
 * @format
 * Fan out a `CaseStudy` payload across the projects-domain tables.
 *
 * Rules enforced here (per spec §"Phase 2 Service 2 / Implementation notes"
 * and §"Constraints & Don'ts"):
 *
 *   - **Sticky edits.** `projects.user_overrides` carries flags for each
 *     top-level section the user has touched. Sections marked sticky are
 *     never overwritten. Today's keys: `tagline`, `pitch`, `stack`,
 *     `decisions`, `highlights`, `challenges`, `depthMarkers`,
 *     `architecture`, `resumeBullets`.
 *   - **Idempotent regeneration.** Every per-section row (decisions /
 *     highlights / challenges / stack-items) is keyed by
 *     `(project_id, content_hash)` thanks to migration 033. Re-running
 *     case-study generation on the same evidence inserts nothing new.
 *   - **Run traceability.** Every row written carries the
 *     `pipeline_run_id` that produced it so a follow-up audit can answer
 *     "which run wrote this?".
 *
 * One transaction per call.
 */
import type { PoolClient } from 'pg';

import type {
    CaseStudy,
    SourceSignal,
} from './case-study-types.js';
import { computeContentHash } from './source-signals.js';
import {
    buildVerifiedStackMap,
    stampStackSignals,
    type VerifiedTechEntry,
} from './case-study-verified-stack.js';
import { normaliseMermaidSource } from './mermaid-normalise.js';

/** technology_evidence lanes that represent real code-declared dependencies. */
const CODE_LAYERS = ['syft', 'treesitter', 'iac', 'dockerfile'];

/**
 * Load the SBOM-grounded stack map for a project from `technology_evidence`,
 * scoped to the project's repos. The persistence-side twin of the loader's
 * verifiedStack — carries file:line so each stamped stack item cites its exact
 * declaration. Empty when the repos have no extracted evidence.
 */
async function loadVerifiedStackMap(
    client: PoolClient,
    userId: string,
    projectId: string,
): Promise<Map<string, VerifiedTechEntry>> {
    const { rows } = await client.query<{ canonical_name: string; version: string | null; purl: string | null; file_path: string | null; line_start: number | null }>(
        `SELECT o.canonical_name, te.version, te.purl, te.file_path, te.line_start
           FROM technology_evidence te
           JOIN technology_ontology o ON o.id = te.technology_id
           JOIN repositories r ON r.full_name = te.repo_full_name AND r.user_id = te.user_id
           JOIN project_repositories pr ON pr.repository_id = r.id
           JOIN project_components pc ON pc.id = pr.project_component_id
          WHERE pc.project_id = $1 AND te.user_id = $2
            AND te.source_layer = ANY($3)`,
        [projectId, userId, CODE_LAYERS],
    );
    return buildVerifiedStackMap(rows.map((r) => ({
        canonicalName: r.canonical_name,
        version:       r.version,
        purl:          r.purl,
        filePath:      r.file_path,
        lineStart:     r.line_start,
    })));
}

export interface PersistCaseStudyInput {
    readonly projectId:      string;
    readonly userId:         string;
    readonly pipelineRunId:  string;
    readonly model:          string;
    readonly inputHash:      string;
    readonly caseStudy:      CaseStudy;
    readonly computedArchetype?: string | null;
    readonly computedStage?:     string | null;
}

export interface PersistCaseStudySummary {
    readonly stackItemsInserted:   number;
    readonly stackItemsPruned:     number;
    readonly decisionsInserted:    number;
    readonly decisionsPruned:      number;
    readonly highlightsInserted:   number;
    readonly highlightsPruned:     number;
    readonly challengesInserted:   number;
    readonly challengesPruned:     number;
    readonly resumeBulletSetsUpserted: number;
    readonly architectureUpserted: boolean;
    readonly depthMarkersUpserted: boolean;
    readonly skippedSections:      readonly string[];
}

type StickyOverrides = Record<string, unknown>;

function isSticky(overrides: StickyOverrides, key: string): boolean {
    return overrides[key] === true;
}

async function lookupComponentIdByName(
    client: PoolClient,
    projectId: string,
    componentName: string | undefined,
): Promise<string | null> {
    if (!componentName) return null;
    const r = await client.query<{ id: string }>(
        `SELECT id FROM project_components WHERE project_id = $1 AND name = $2 LIMIT 1`,
        [projectId, componentName],
    );
    return r.rows[0]?.id ?? null;
}

async function loadProjectUserOverrides(
    client: PoolClient,
    projectId: string,
): Promise<StickyOverrides> {
    const r = await client.query<{ user_overrides: StickyOverrides | null }>(
        `SELECT user_overrides FROM projects WHERE id = $1`,
        [projectId],
    );
    return r.rows[0]?.user_overrides ?? {};
}

async function upsertProjectTopFields(
    client: PoolClient,
    input: PersistCaseStudyInput,
    overrides: StickyOverrides,
): Promise<{ taglineUpdated: boolean; pitchUpdated: boolean; nameUpdated: boolean }> {
    const cs = input.caseStudy;
    const updateTagline = !isSticky(overrides, 'tagline');
    const updatePitch   = !isSticky(overrides, 'pitch');
    // The model's product name replaces repo-slug project names. Sticky
    // 'name' (user renamed it themselves) always wins; absent displayName
    // (pre-rename cached artefact) leaves the name untouched.
    const updateName    = !isSticky(overrides, 'name') && Boolean(cs.displayName?.trim());

    await client.query(
        `UPDATE projects
            SET tagline = CASE WHEN $2 THEN $3 ELSE tagline END,
                pitch   = CASE WHEN $4 THEN $5 ELSE pitch   END,
                name    = CASE WHEN $11 THEN $12 ELSE name END,
                case_study_status            = 'complete',
                case_study_generated_at      = NOW(),
                case_study_pipeline_run_id   = $6,
                case_study_model             = $7,
                case_study_input_hash        = $8,
                computed_archetype           = $9::text,
                computed_stage               = $10::text,
                archetype_computed_at        = CASE WHEN $9::text IS NOT NULL THEN NOW() ELSE archetype_computed_at END,
                updated_at                   = NOW()
          WHERE id = $1`,
        [
            input.projectId,
            updateTagline, cs.tagline,
            updatePitch,   cs.pitch,
            input.pipelineRunId,
            input.model,
            input.inputHash,
            input.computedArchetype ?? null,
            input.computedStage ?? null,
            updateName, cs.displayName ?? null,
        ],
    );
    return { taglineUpdated: updateTagline, pitchUpdated: updatePitch, nameUpdated: updateName };
}

/**
 * Reconcile a generated list section to EXACTLY the current payload, idempotently:
 *
 *   1. Insert each current row if its (project_id, content_hash) isn't already
 *      present — so an unchanged row keeps its id/order, costing one no-op.
 *   2. Prune stale machine rows: delete this project's rows whose content_hash
 *      is not in the current set. This is what stops regeneration from
 *      ACCUMULATING superseded rows (the dup bug) when the agent's output changes
 *      or a repo is added.
 *
 * Two rows are never pruned: NULL-content_hash rows (user-authored — `NULL <> x`
 * is NULL, so they fall out of the delete) and, when `preserveUserConfirmed`,
 * rows the user has confirmed. Returns the numbers inserted and pruned.
 */
async function insertGenerated(
    client: PoolClient,
    table: 'project_decisions' | 'project_highlights' | 'project_challenges' | 'project_stack_items',
    input: PersistCaseStudyInput,
    rows: ReadonlyArray<{
        contentFields: ReadonlyArray<string | null | undefined>;
        signals:       SourceSignal;
        columns:       Record<string, unknown>;
    }>,
    opts: { preserveUserConfirmed?: boolean } = {},
): Promise<{ inserted: number; pruned: number }> {
    let inserted = 0;
    const currentHashes: string[] = [];
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const hash = computeContentHash(row.contentFields, row.signals);
        currentHashes.push(hash);
        const cols  = [
            'user_id', 'project_id',
            ...Object.keys(row.columns),
            'source_signals', 'content_hash', 'pipeline_run_id', 'order_index',
        ];
        const vals  = [
            input.userId, input.projectId,
            ...Object.values(row.columns),
            JSON.stringify(row.signals), hash, input.pipelineRunId, i,
        ];
        const placeholders = vals.map((_, idx) => `$${idx + 1}`);
        const hashIdx = cols.indexOf('content_hash') + 1; // $-index

        // The unique index on (project_id, content_hash) is partial
        // (WHERE content_hash IS NOT NULL). Postgres refuses ON CONFLICT
        // against partial indexes by name without the matching predicate,
        // so we guard with WHERE NOT EXISTS — equivalent semantics, no
        // index gymnastics.
        const insertSql = `
            INSERT INTO ${table} (${cols.join(', ')})
            SELECT ${placeholders.join(', ')}
            WHERE NOT EXISTS (
              SELECT 1 FROM ${table}
              WHERE project_id = $2 AND content_hash = $${hashIdx}
            )
        `;
        const r = await client.query(insertSql, vals);
        inserted += r.rowCount ?? 0;
        if ((r.rowCount ?? 0) === 0) {
            // Row already exists from a prior run (unchanged content). Align
            // its order_index with the current payload position — kept rows
            // otherwise retain stale indices and collide with newly-inserted
            // ones (observed live: two challenges sharing order_index 2).
            await client.query(
                `UPDATE ${table}
                    SET order_index = $3
                  WHERE project_id = $1 AND content_hash = $2 AND order_index <> $3`,
                [input.projectId, hash, i],
            );
        }
    }

    // Prune superseded machine rows so the section reflects only the current run.
    const preserveClause = opts.preserveUserConfirmed ? ' AND is_user_confirmed = FALSE' : '';
    let pruned = 0;
    if (currentHashes.length > 0) {
        const deleted = await client.query(
            `DELETE FROM ${table}
              WHERE project_id = $1
                AND content_hash <> ALL($2::text[])${preserveClause}`,
            [input.projectId, currentHashes],
        );
        pruned = deleted.rowCount ?? 0;
    } else {
        // The agent produced no rows for this section — clear stale machine rows
        // (NULL-hash user rows and, if requested, user-confirmed rows survive).
        const deleted = await client.query(
            `DELETE FROM ${table}
              WHERE project_id = $1
                AND content_hash IS NOT NULL${preserveClause}`,
            [input.projectId],
        );
        pruned = deleted.rowCount ?? 0;
    }
    return { inserted, pruned };
}

async function upsertDepthMarkers(
    client: PoolClient,
    input: PersistCaseStudyInput,
): Promise<boolean> {
    const d = input.caseStudy.depthMarkers;
    // The model no longer emits depthMarkers; the orchestrator injects the
    // deterministic values whenever the loader derived them. Absent → keep
    // the last computed row rather than overwrite with nothing.
    if (!d) return false;
    await client.query(
        `INSERT INTO project_depth_markers (
            user_id, project_id, has_tests, test_coverage_signal, has_ci,
            ci_maturity, documentation_density, has_deployment_evidence,
            deployment_url, refactor_count, computed_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, NOW())
         ON CONFLICT (project_id) DO UPDATE
           SET has_tests              = EXCLUDED.has_tests,
               test_coverage_signal   = EXCLUDED.test_coverage_signal,
               has_ci                 = EXCLUDED.has_ci,
               ci_maturity            = EXCLUDED.ci_maturity,
               documentation_density  = EXCLUDED.documentation_density,
               has_deployment_evidence = EXCLUDED.has_deployment_evidence,
               deployment_url         = EXCLUDED.deployment_url,
               refactor_count         = EXCLUDED.refactor_count,
               computed_at            = NOW()`,
        [
            input.userId, input.projectId,
            d.hasTests, d.testCoverageSignal, d.hasCi, d.ciMaturity,
            d.documentationDensity, d.hasDeploymentEvidence,
            d.deploymentUrl ?? null, d.refactorCount,
        ],
    );
    return true;
}

export async function upsertArchitecture(
    client: PoolClient,
    input: PersistCaseStudyInput,
): Promise<boolean> {
    const a = input.caseStudy.architecture;
    const diagramSource = a.diagramFormat === 'mermaid'
        ? normaliseMermaidSource(a.diagramSource)
        : a.diagramSource;
    await client.query(
        `INSERT INTO project_architecture (
            user_id, project_id, diagram_format, diagram_source, nodes, edges,
            generated_at, is_user_edited, pipeline_run_id
         )
         VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb, NOW(), FALSE, $7)
         ON CONFLICT (project_id) DO UPDATE
           SET diagram_format  = EXCLUDED.diagram_format,
               diagram_source  = EXCLUDED.diagram_source,
               nodes           = EXCLUDED.nodes,
               edges           = EXCLUDED.edges,
               generated_at    = NOW(),
               -- Don't clobber user edits.
               is_user_edited  = project_architecture.is_user_edited,
               pipeline_run_id = EXCLUDED.pipeline_run_id
         WHERE project_architecture.is_user_edited = FALSE`,
        [
            input.userId, input.projectId,
            a.diagramFormat, diagramSource,
            JSON.stringify(a.nodes), JSON.stringify(a.edges),
            input.pipelineRunId,
        ],
    );
    return true;
}

async function upsertResumeBullets(
    client: PoolClient,
    input: PersistCaseStudyInput,
): Promise<number> {
    let upserted = 0;
    for (const set of input.caseStudy.resumeBullets) {
        const r = await client.query(
            `INSERT INTO project_resume_bullets (
                user_id, project_id, angle, bullets, generated_at, pipeline_run_id
             )
             VALUES ($1,$2,$3,$4::jsonb, NOW(), $5)
             ON CONFLICT (project_id, angle) DO UPDATE
               SET bullets        = EXCLUDED.bullets,
                   generated_at   = NOW(),
                   pipeline_run_id = EXCLUDED.pipeline_run_id`,
            [
                input.userId, input.projectId,
                set.angle, JSON.stringify(set.bullets),
                input.pipelineRunId,
            ],
        );
        upserted += r.rowCount ?? 0;
    }
    return upserted;
}

export async function persistCaseStudy(
    client: PoolClient,
    input: PersistCaseStudyInput,
): Promise<PersistCaseStudySummary> {
    await client.query('BEGIN');
    try {
        const overrides   = await loadProjectUserOverrides(client, input.projectId);
        const skippedSections: string[] = [];
        const skip = (key: string): void => { if (isSticky(overrides, key)) skippedSections.push(key); };

        await upsertProjectTopFields(client, input, overrides);
        skip('tagline');
        skip('pitch');

        let stackItemsInserted = 0;
        let stackItemsPruned = 0;
        if (!isSticky(overrides, 'stack')) {
            // SBOM-ground each stack item: stamp its real version + purl +
            // declaration file:line when it matches a code dependency, or flag
            // it when it grounds to nothing. Deterministic, server-side — the
            // model never sets these.
            const verifiedMap = await loadVerifiedStackMap(client, input.userId, input.projectId);
            const stackRows = await Promise.all(
                input.caseStudy.stack.map(async (s) => ({
                    contentFields: [s.category, s.name, s.justification],
                    signals:       stampStackSignals(s.name, s.sourceSignals, verifiedMap),
                    columns: {
                        category:               s.category,
                        name:                   s.name,
                        justification:          s.justification,
                        used_in_component_id:   await lookupComponentIdByName(client, input.projectId, s.componentName),
                    },
                })),
            );
            const stackSummary = await insertGenerated(client, 'project_stack_items', input, stackRows);
            stackItemsInserted = stackSummary.inserted;
            stackItemsPruned = stackSummary.pruned;
        } else {
            skippedSections.push('stack');
        }

        let decisionsInserted = 0;
        let decisionsPruned = 0;
        if (!isSticky(overrides, 'decisions')) {
            const decisionsSummary = await insertGenerated(client, 'project_decisions', input,
                input.caseStudy.decisions.map((d) => ({
                    contentFields: [d.title, d.context, d.decision, d.consequences],
                    signals:       d.sourceSignals,
                    columns: {
                        title:        d.title,
                        context:      d.context,
                        decision:     d.decision,
                        consequences: d.consequences,
                        confidence:   d.confidence,
                        is_user_confirmed: false,
                    },
                })),
                { preserveUserConfirmed: true },
            );
            decisionsInserted = decisionsSummary.inserted;
            decisionsPruned = decisionsSummary.pruned;
        } else {
            skippedSections.push('decisions');
        }

        let highlightsInserted = 0;
        let highlightsPruned = 0;
        if (!isSticky(overrides, 'highlights')) {
            const highlightsSummary = await insertGenerated(client, 'project_highlights', input,
                input.caseStudy.highlights.map((h) => ({
                    contentFields: [h.title, h.description],
                    signals:       h.sourceSignals,
                    columns: {
                        title:       h.title,
                        description: h.description,
                    },
                })),
            );
            highlightsInserted = highlightsSummary.inserted;
            highlightsPruned = highlightsSummary.pruned;
        } else {
            skippedSections.push('highlights');
        }

        let challengesInserted = 0;
        let challengesPruned = 0;
        if (!isSticky(overrides, 'challenges')) {
            const challengesSummary = await insertGenerated(client, 'project_challenges', input,
                input.caseStudy.challenges.map((c) => ({
                    contentFields: [c.problem, c.solution],
                    signals:       c.sourceSignals,
                    columns: {
                        problem:  c.problem,
                        solution: c.solution,
                    },
                })),
            );
            challengesInserted = challengesSummary.inserted;
            challengesPruned = challengesSummary.pruned;
        } else {
            skippedSections.push('challenges');
        }

        let depthMarkersUpserted = false;
        if (!isSticky(overrides, 'depthMarkers')) {
            depthMarkersUpserted = await upsertDepthMarkers(client, input);
        } else {
            skippedSections.push('depthMarkers');
        }

        let architectureUpserted = false;
        if (!isSticky(overrides, 'architecture')) {
            architectureUpserted = await upsertArchitecture(client, input);
        } else {
            skippedSections.push('architecture');
        }

        let resumeBulletSetsUpserted = 0;
        if (!isSticky(overrides, 'resumeBullets')) {
            resumeBulletSetsUpserted = await upsertResumeBullets(client, input);
        } else {
            skippedSections.push('resumeBullets');
        }

        await client.query('COMMIT');
        return {
            stackItemsInserted,
            stackItemsPruned,
            decisionsInserted,
            decisionsPruned,
            highlightsInserted,
            highlightsPruned,
            challengesInserted,
            challengesPruned,
            resumeBulletSetsUpserted,
            architectureUpserted,
            depthMarkersUpserted,
            skippedSections,
        };
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    }
}
