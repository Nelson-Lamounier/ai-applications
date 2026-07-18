/**
 * @format
 * Deterministic concept coverage eval (P2 Task 5) — LOCAL / CI, not deployed.
 *
 * Answers "of the JD 'concept' mentions (`jdExtraction.concepts`) stored
 * across a user's strategist runs, how many resolve to a canonical the user
 * has deterministic `concept_evidence` for (migration 123 detector facts) vs
 * a real-but-unevidenced canonical vs a concept the ontology has no entry for
 * at all?" — over REAL stored analyses, no LLM, no Bedrock, pure SQL + the
 * deterministic `classifyConceptCoverage` classifier.
 *
 * The corpus mixes evidence-able concepts (observability, distributed
 * systems, ...) with career-only concepts a code detector could never see
 * (e.g. "technical support") — so this is a REPORT, human-judged, not a
 * baseline-regression gate (v1). The one automated assertion is a sanity
 * check: no concept absent from `skill_ontology` may ever classify as
 * `covered` — that would mean the eval's own ontology-membership check
 * regressed, not a real coverage win.
 *
 * Steps:
 *  1. Load every strategist `pipeline_runs` row that stored
 *     `metadata->'jdExtraction'->'concepts'`.
 *  2. Load the user's evidenced concept canonicals (`concept_evidence`
 *     joined `skill_ontology`, migration 123).
 *  3. Load the full ontology canonical set + the skill alias -> canonical
 *     map (`SkillOntologyRepository` — SAME loaders the production research
 *     agent's concept-evidence context build uses, see
 *     `run-pipeline.ts`/`concept-evidence-context.ts`).
 *  4. Classify every stored concept mention (`classifyConceptCoverage`).
 *  5. Print a per-concept table + coverage fraction; assert the ontology
 *     sanity invariant; exit non-zero only when that invariant is violated.
 *
 * Run:
 *   USER_ID=<uuid> PG_HOST=127.0.0.1 PG_PORT=15432 PG_DATABASE=tucaken \
 *   PG_USER=postgres PG_PASSWORD=<secret> \
 *   npx tsx src/evals/transfer/run-concept-coverage-eval.ts
 *   (from applications/job-strategist, with an SSM tunnel to dev RDS open)
 *
 * Exit codes: 0 = report printed / sanity check passed, 1 = bad env / DB
 * failure / sanity check violated.
 */
import { Pool } from 'pg';
import { SkillOntologyRepository } from '@bedrock/shared';

import { classifyConceptCoverage, type ConceptCoverageKind } from './concept-coverage-classify.js';

function requireEnv(name: string): string {
    const v = process.env[name];
    if (!v) throw new Error(`Missing required env var: ${name}`);
    return v;
}

function makePool(): Pool {
    return new Pool({
        host:     requireEnv('PG_HOST'),
        port:     Number.parseInt(process.env['PG_PORT'] ?? '5432', 10),
        database: requireEnv('PG_DATABASE'),
        user:     requireEnv('PG_USER'),
        password: requireEnv('PG_PASSWORD'),
        max:      3,
    });
}

interface StrategistConceptsRow {
    readonly id: string;
    readonly concepts: unknown;
}

interface ConceptOccurrence {
    readonly runId: string;
    readonly concept: string;
}

/** Step 1: every strategist run that stored a JD concepts lane. */
async function loadStrategistConcepts(pool: Pool, userId: string): Promise<StrategistConceptsRow[]> {
    const { rows } = await pool.query<StrategistConceptsRow>(
        `SELECT id, metadata->'jdExtraction'->'concepts' AS concepts
           FROM pipeline_runs
          WHERE user_id = $1
            AND pipeline_type = 'strategist'
            AND metadata ? 'jdExtraction'`,
        [userId],
    );
    return rows;
}

/** Step 2: canonical concepts the user has at least one concept_evidence row for. */
async function loadEvidencedConceptCanonicals(pool: Pool, userId: string): Promise<Set<string>> {
    const { rows } = await pool.query<{ canonical: string }>(
        `SELECT DISTINCT lower(so.canonical_name) AS canonical
           FROM concept_evidence ce
           JOIN skill_ontology so ON so.id = ce.skill_id
          WHERE ce.user_id = $1`,
        [userId],
    );
    return new Set(rows.map((r) => r.canonical));
}

/** Flatten every stored `jdExtraction.concepts[]` string across all runs. */
function extractConceptOccurrences(rows: readonly StrategistConceptsRow[]): ConceptOccurrence[] {
    const occurrences: ConceptOccurrence[] = [];
    for (const row of rows) {
        if (!Array.isArray(row.concepts)) continue;
        for (const concept of row.concepts as unknown[]) {
            if (typeof concept === 'string' && concept.trim().length > 0) {
                occurrences.push({ runId: row.id, concept });
            }
        }
    }
    return occurrences;
}

interface ConceptRow {
    canonical: string;
    occurrences: number;
    classification: ConceptCoverageKind;
}

/** Step 4: classify every occurrence, aggregated by resolved canonical (classification
 *  is a pure function of fixed inputs, so all occurrences of the same canonical always
 *  land in the same bucket). */
function classifyOccurrences(
    occurrences: readonly ConceptOccurrence[],
    evidenced: ReadonlySet<string>,
    ontologyCanonicals: ReadonlySet<string>,
    aliasToCanonical: Map<string, string>,
): ConceptRow[] {
    const byCanonical = new Map<string, ConceptRow>();
    for (const occ of occurrences) {
        const result = classifyConceptCoverage(occ.concept, evidenced, ontologyCanonicals, aliasToCanonical);
        const existing = byCanonical.get(result.canonical);
        if (existing) {
            existing.occurrences += 1;
            continue;
        }
        byCanonical.set(result.canonical, {
            canonical:      result.canonical,
            occurrences:    1,
            classification: result.classification,
        });
    }
    return [...byCanonical.values()].sort(
        (a, b) => b.occurrences - a.occurrences || a.canonical.localeCompare(b.canonical),
    );
}

/** Step 5 (table half): a markdown table, occurrence-descending. */
function formatTable(conceptRows: readonly ConceptRow[]): string {
    const rows = conceptRows.map((r) =>
        `| ${r.canonical} | ${r.occurrences} | ${r.classification} |`,
    );
    return [
        '| concept | occurrences | classification |',
        '| --- | --- | --- |',
        ...rows,
    ].join('\n');
}

interface Summary {
    total: number;
    covered: number;
    uncovered: number;
    unknownConcept: number;
}

function summarise(conceptRows: readonly ConceptRow[]): Summary {
    let total = 0;
    let covered = 0;
    let uncovered = 0;
    let unknownConcept = 0;
    for (const r of conceptRows) {
        total += r.occurrences;
        if (r.classification === 'covered') covered += r.occurrences;
        else if (r.classification === 'uncovered') uncovered += r.occurrences;
        else unknownConcept += r.occurrences;
    }
    return { total, covered, uncovered, unknownConcept };
}

function formatSummary(s: Summary): string {
    const pct = (n: number): string => (s.total === 0 ? 'n/a' : `${((n / s.total) * 100).toFixed(1)}%`);
    // Coverage fraction is scoped to real (ontology-known) concepts — an
    // unknown-concept can never be "covered", so including it in the
    // denominator would understate coverage of the evidence-able universe.
    const known = s.covered + s.uncovered;
    const coveragePct = known === 0 ? 'n/a' : `${((s.covered / known) * 100).toFixed(1)}%`;
    return [
        `total stored JD concept occurrences: ${s.total}`,
        `  covered:          ${s.covered} (${pct(s.covered)})`,
        `  uncovered:        ${s.uncovered} (${pct(s.uncovered)})`,
        `  unknown-concept:  ${s.unknownConcept} (${pct(s.unknownConcept)})`,
        `coverage fraction (covered / (covered + uncovered), ontology-known concepts only): ${coveragePct}`,
    ].join('\n');
}

/**
 * Sanity assertion — re-verifies, over the classified OUTPUT rows, that no
 * concept absent from `ontologyCanonicals` was ever marked `covered`. The
 * classifier already enforces this by construction (ontology-membership
 * check runs before the evidence check), so this guards the eval's own
 * plumbing (wrong ontology load, canonicalisation drift) rather than the
 * classifier's internal logic. Returns the list of violated concepts (empty
 * = sanity check passed).
 */
function assertOntologySanity(conceptRows: readonly ConceptRow[], ontologyCanonicals: ReadonlySet<string>): string[] {
    const violations: string[] = [];
    for (const r of conceptRows) {
        if (r.classification === 'covered' && !ontologyCanonicals.has(r.canonical)) {
            violations.push(`'${r.canonical}' classified as covered but is absent from skill_ontology`);
        }
    }
    return violations;
}

async function main(): Promise<void> {
    const userId = requireEnv('USER_ID');
    const pool = makePool();

    try {
        const skillRepo = new SkillOntologyRepository(pool);

        const [strategistRows, evidenced, canonicalNames, aliasToCanonical] = await Promise.all([
            loadStrategistConcepts(pool, userId),
            loadEvidencedConceptCanonicals(pool, userId),
            skillRepo.loadCanonicalNames(),
            skillRepo.loadAliasToCanonicalMap(),
        ]);
        const ontologyCanonicals = new Set(canonicalNames);

        console.log(`==> loaded ${strategistRows.length} strategist run(s) with a jdExtraction lane, ${evidenced.size} evidenced concept canonical(s), ${ontologyCanonicals.size} ontology canonical(s)`);

        const occurrences = extractConceptOccurrences(strategistRows);
        console.log(`==> ${occurrences.length} stored JD concept occurrence(s) across ${strategistRows.length} run(s)`);

        const conceptRows = classifyOccurrences(occurrences, evidenced, ontologyCanonicals, aliasToCanonical);
        console.log('\n' + formatTable(conceptRows));
        console.log('\n' + formatSummary(summarise(conceptRows)));

        const violations = assertOntologySanity(conceptRows, ontologyCanonicals);
        if (violations.length > 0) {
            console.error('\n==> SANITY CHECK FAILED:');
            for (const v of violations) console.error(`  - ${v}`);
            process.exitCode = 1;
            return;
        }
        console.log('\n==> sanity check passed (report-only eval — no baseline gate in v1; coverage is human-judged)');
    } finally {
        await pool.end();
    }
}

main().catch((err) => {
    console.error('concept-coverage eval failed:', err);
    process.exitCode = 1;
});
