/** @format */
import type { Pool } from 'pg';
import type {
    StageExpectation, CompanyInterviewProfile, PrepScaffold, CompBenchmark, ScaffoldKind,
} from '../../stage-prep/stage-prep-types.js';

interface ExpRow {
    id: string; company_type: string; role_family: string; stage: string;
    focus_areas: string[]; question_patterns: Array<{ type: string; prompt_hint: string }>;
    expectation_note: string | null;
}
interface ProfileRow {
    company_key: string; display_name: string; company_type: string;
    leadership_principles: Array<{ name: string; description: string }>;
    process_shape: Array<{ stage: string; format: string; note: string }>;
    values_taxonomy: Array<{ name: string; description: string }>;
}
interface ScaffoldRow { id: string; kind: ScaffoldKind; title: string; structure: Record<string, unknown>; }
interface CompRow {
    id: string; role_family: string; seniority: string; region: string; currency: string;
    range_min: number; range_p50: number; range_max: number;
}

function toExpectation(r: ExpRow): StageExpectation {
    return {
        id: r.id, companyType: r.company_type, roleFamily: r.role_family, stage: r.stage,
        focusAreas: r.focus_areas ?? [],
        questionPatterns: (r.question_patterns ?? []).map(q => ({ type: q.type, promptHint: q.prompt_hint })),
        expectationNote: r.expectation_note ?? null,
    };
}

const EXP_SQL =
    `SELECT id, company_type, role_family, stage, focus_areas, question_patterns, expectation_note
       FROM stage_expectations WHERE company_type = $1 AND role_family = $2 AND stage = $3`;

export class RdsStagePrepOntologyRepository {
    constructor(private readonly pool: Pool) {}

    /** Exact → ('*', role, stage) → ('*','*', stage) → null. */
    async getStageExpectation(companyType: string, roleFamily: string, stage: string): Promise<StageExpectation | null> {
        const tiers: Array<[string, string, string]> = [
            [companyType, roleFamily, stage],
            ['*', roleFamily, stage],
            ['*', '*', stage],
        ];
        const seen = new Set<string>();
        for (const [ct, rf, st] of tiers) {
            const key = `${ct}|${rf}|${st}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const r = await this.pool.query<ExpRow>(EXP_SQL, [ct, rf, st]);
            if (r.rows[0]) return toExpectation(r.rows[0]);
        }
        return null;
    }

    async getCompanyProfile(companyKey: string): Promise<CompanyInterviewProfile | null> {
        const r = await this.pool.query<ProfileRow>(
            `SELECT company_key, display_name, company_type, leadership_principles, process_shape, values_taxonomy
               FROM company_interview_profiles WHERE company_key = $1`, [companyKey]);
        const row = r.rows[0];
        if (!row) return null;
        return {
            companyKey: row.company_key, displayName: row.display_name, companyType: row.company_type,
            leadershipPrinciples: row.leadership_principles ?? [],
            processShape: row.process_shape ?? [],
            valuesTaxonomy: row.values_taxonomy ?? [],
        };
    }

    async listScaffolds(kind: ScaffoldKind): Promise<PrepScaffold[]> {
        const r = await this.pool.query<ScaffoldRow>(
            `SELECT id, kind, title, structure FROM prep_scaffolds WHERE kind = $1`, [kind]);
        return r.rows.map(row => ({ id: row.id, kind: row.kind, title: row.title, structure: row.structure ?? {} }));
    }

    /** Exact (role, sen, region) → ('*', sen, region) → null. Free comp data is mostly generic-SWE. */
    async getCompBenchmark(roleFamily: string, seniority: string, region: string): Promise<CompBenchmark | null> {
        const families = roleFamily === '*' ? [roleFamily] : [roleFamily, '*'];
        for (const rf of families) {
            const r = await this.pool.query<CompRow>(
                `SELECT id, role_family, seniority, region, currency, range_min, range_p50, range_max
                   FROM comp_benchmarks WHERE role_family = $1 AND seniority = $2 AND region = $3`,
                [rf, seniority, region]);
            const row = r.rows[0];
            if (row) {
                return {
                    id: row.id, roleFamily: row.role_family, seniority: row.seniority as CompBenchmark['seniority'],
                    region: row.region, currency: row.currency,
                    rangeMin: row.range_min, rangeP50: row.range_p50, rangeMax: row.range_max,
                };
            }
        }
        return null;
    }
}
