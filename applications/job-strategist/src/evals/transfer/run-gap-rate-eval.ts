/**
 * @format
 * Deterministic transfer gap-rate eval (P0 Task 6) — LOCAL / CI, not deployed.
 *
 * Answers "what fraction of the JD skills stored strategist runs marked as
 * gaps were actually false gaps (direct evidence) or transfer-convertible
 * (an evidenced sibling in a TYPED transfer group), vs an honest gap?" over
 * REAL stored analyses — no LLM, no Bedrock, pure SQL + the deterministic
 * `classifyGap` classifier.
 *
 * Steps:
 *  1. Load every strategist `pipeline_runs` row that stored both
 *     `metadata->'jdExtraction'` and `metadata->'research'`.
 *  2. Load the user's evidenced canonicals (code/IaC/SBOM/Dockerfile layers
 *     only — never README/code-prose).
 *  3. Load the typed transfer groups (`loadTransferGroups()`) + the
 *     alias -> canonical map (`loadAliasToCanonicalMap()`) — SAME loaders the
 *     production research agent uses, so this eval measures the exact
 *     ontology data the pipeline runs against.
 *  4. Classify every stored gap (`research.gaps[].skill`) with `classifyGap`.
 *  5. Print a per-skill table + summary percentages; exit non-zero if the
 *     spec's gate is violated (see `assertGate` below).
 *
 * Run:
 *   USER_ID=<uuid> PG_HOST=127.0.0.1 PG_PORT=15432 PG_DATABASE=tucaken \
 *   PG_USER=postgres PG_PASSWORD=<secret> \
 *   npx tsx src/evals/transfer/run-gap-rate-eval.ts
 *   (from applications/job-strategist, with an SSM tunnel to dev RDS open)
 *
 * Exit codes: 0 = gate passed, 1 = bad env / DB failure / gate violated.
 */
import { Pool } from 'pg';
import { TechnologyOntologyRepository, type TechTransferGroup, type TransferTier } from '@bedrock/shared';

import { classifyGap, type GapClassificationKind } from './gap-classify.js';

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

interface StoredGap {
    readonly skill?: unknown;
}

interface StrategistRunRow {
    readonly id: string;
    readonly research: { gaps?: unknown } | null;
}

interface GapOccurrence {
    readonly runId: string;
    readonly skill: string;
}

/** Step 1: every strategist run that stored both jdExtraction and research. */
async function loadStrategistRuns(pool: Pool, userId: string): Promise<StrategistRunRow[]> {
    const { rows } = await pool.query<StrategistRunRow>(
        `SELECT id, metadata->'research' AS research
           FROM pipeline_runs
          WHERE user_id = $1
            AND pipeline_type = 'strategist'
            AND metadata ? 'jdExtraction'
            AND metadata ? 'research'`,
        [userId],
    );
    return rows;
}

/** Step 2: the user's evidenced canonicals — code/IaC/SBOM/Dockerfile layers only. */
async function loadEvidencedCanonicals(pool: Pool, userId: string): Promise<Set<string>> {
    const { rows } = await pool.query<{ canonical: string }>(
        `SELECT DISTINCT lower(o.canonical_name) AS canonical
           FROM technology_evidence te
           JOIN technology_ontology o ON o.id = te.technology_id
          WHERE te.user_id = $1
            AND te.source_layer = ANY('{syft,treesitter,iac,dockerfile}')`,
        [userId],
    );
    return new Set(rows.map((r) => r.canonical));
}

/** Flatten every stored `research.gaps[].skill` string across all runs. */
function extractGapOccurrences(runs: readonly StrategistRunRow[]): GapOccurrence[] {
    const occurrences: GapOccurrence[] = [];
    for (const run of runs) {
        const gaps = run.research?.gaps;
        if (!Array.isArray(gaps)) continue;
        for (const gap of gaps as StoredGap[]) {
            const skill = gap?.skill;
            if (typeof skill === 'string' && skill.trim().length > 0) {
                occurrences.push({ runId: run.id, skill });
            }
        }
    }
    return occurrences;
}

interface SkillRow {
    canonical: string;
    occurrences: number;
    classification: GapClassificationKind;
    via?: string;
    transferTier?: TransferTier;
}

/** Step 4: classify every occurrence, aggregated by resolved canonical
 *  (classification is a pure function of fixed inputs, so all occurrences of
 *  the same canonical always land in the same bucket). */
function classifyOccurrences(
    occurrences: readonly GapOccurrence[],
    evidenced: ReadonlySet<string>,
    groups: readonly TechTransferGroup[],
    aliasToCanonical: Map<string, string>,
): SkillRow[] {
    const byCanonical = new Map<string, SkillRow>();
    for (const occ of occurrences) {
        const result = classifyGap(occ.skill, evidenced, groups, aliasToCanonical);
        const existing = byCanonical.get(result.canonical);
        if (existing) {
            existing.occurrences += 1;
            continue;
        }
        byCanonical.set(result.canonical, {
            canonical:      result.canonical,
            occurrences:    1,
            classification: result.classification,
            ...(result.via ? { via: result.via } : {}),
            ...(result.transferTier ? { transferTier: result.transferTier } : {}),
        });
    }
    return [...byCanonical.values()].sort(
        (a, b) => b.occurrences - a.occurrences || a.canonical.localeCompare(b.canonical),
    );
}

/** Step 5 (table half): a markdown table, occurrence-descending. */
function formatTable(skillRows: readonly SkillRow[]): string {
    const rows = skillRows.map((r) =>
        `| ${r.canonical} | ${r.occurrences} | ${r.classification} | ${r.via ?? '-'} | ${r.transferTier ?? '-'} |`,
    );
    return [
        '| skill | occurrences | classification | via | tier |',
        '| --- | --- | --- | --- | --- |',
        ...rows,
    ].join('\n');
}

interface Summary {
    total: number;
    directEvidence: number;
    transferConvertible: number;
    honestGap: number;
}

function summarise(skillRows: readonly SkillRow[]): Summary {
    let total = 0;
    let directEvidence = 0;
    let transferConvertible = 0;
    let honestGap = 0;
    for (const r of skillRows) {
        total += r.occurrences;
        if (r.classification === 'direct-evidence') directEvidence += r.occurrences;
        else if (r.classification === 'transfer-convertible') transferConvertible += r.occurrences;
        else honestGap += r.occurrences;
    }
    return { total, directEvidence, transferConvertible, honestGap };
}

function formatSummary(s: Summary): string {
    const pct = (n: number): string => (s.total === 0 ? 'n/a' : `${((n / s.total) * 100).toFixed(1)}%`);
    return [
        `total stored gap occurrences: ${s.total}`,
        `  direct-evidence (false gaps):   ${s.directEvidence} (${pct(s.directEvidence)})`,
        `  transfer-convertible:           ${s.transferConvertible} (${pct(s.transferConvertible)})`,
        `  honest-gap:                     ${s.honestGap} (${pct(s.honestGap)})`,
    ].join('\n');
}

/**
 * Step 5 (gate half) — asserts the spec's regression gate over the classified
 * per-skill rows:
 *  - none of `ldap` / `kerberos` / `active directory` may classify as
 *    transfer-convertible (there is no legitimate directory-service transfer
 *    basis for these — a convertible verdict here is a false positive).
 *  - at least one of `terraform` / `azure` / `gcp` MUST classify as
 *    transfer-convertible (the typed cloud/IaC transfer groups exist
 *    precisely to convert gaps like these — none converting means the
 *    typed-group wiring regressed).
 *
 * Returns the list of violated conditions (empty = gate passed).
 */
function assertGate(skillRows: readonly SkillRow[]): string[] {
    const byCanonical = new Map(skillRows.map((r) => [r.canonical, r]));
    const violations: string[] = [];

    const mustNotConvert = ['ldap', 'kerberos', 'active directory', 'active_directory'];
    for (const skill of mustNotConvert) {
        const row = byCanonical.get(skill);
        if (row?.classification === 'transfer-convertible') {
            violations.push(`'${skill}' classified as transfer-convertible (via ${row.via ?? 'unknown'}) — no legitimate directory-service transfer basis`);
        }
    }

    const mustConvertAtLeastOne = ['terraform', 'azure', 'gcp'];
    const anyConverted = mustConvertAtLeastOne.some(
        (skill) => byCanonical.get(skill)?.classification === 'transfer-convertible',
    );
    if (!anyConverted) {
        violations.push(`none of ${mustConvertAtLeastOne.join('/')} classified as transfer-convertible — typed cloud/IaC transfer groups may have regressed`);
    }

    return violations;
}

async function main(): Promise<void> {
    const userId = requireEnv('USER_ID');
    const pool = makePool();

    try {
        const techRepo = new TechnologyOntologyRepository(pool);

        const [runs, evidenced, groups, aliasToCanonical] = await Promise.all([
            loadStrategistRuns(pool, userId),
            loadEvidencedCanonicals(pool, userId),
            techRepo.loadTransferGroups(),
            techRepo.loadAliasToCanonicalMap(),
        ]);

        console.log(`==> loaded ${runs.length} strategist run(s), ${evidenced.size} evidenced canonical(s), ${groups.length} transfer group(s)`);

        const occurrences = extractGapOccurrences(runs);
        console.log(`==> ${occurrences.length} stored gap occurrence(s) across ${runs.length} run(s)`);

        const skillRows = classifyOccurrences(occurrences, evidenced, groups, aliasToCanonical);
        console.log('\n' + formatTable(skillRows));
        console.log('\n' + formatSummary(summarise(skillRows)));

        const violations = assertGate(skillRows);
        if (violations.length > 0) {
            console.error('\n==> GATE FAILED:');
            for (const v of violations) console.error(`  - ${v}`);
            process.exitCode = 1;
            return;
        }
        console.log('\n==> gate passed');
    } finally {
        await pool.end();
    }
}

main().catch((err) => {
    console.error('gap-rate eval failed:', err);
    process.exitCode = 1;
});
