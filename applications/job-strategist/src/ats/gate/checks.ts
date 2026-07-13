/** @format */
import type { AtsCheckResult } from './ats-check.schema.js';
import { STANDARD_SECTIONS } from './parse-back.js';

const REQUIRED_SECTIONS = ['Experience', 'Skills', 'Education'] as const;

export type CoverageRow = AtsCheckResult['jdKeywordCoverage'][number];

export interface BuildAtsCheckArgs {
    readonly text: string;
    readonly sections: string[];
    readonly profile: { name: string; email: string };
    /**
     * Pre-computed keyword coverage (with tier). When provided, `jdMustHaves`
     * and `groundedTerms` are ignored for coverage — pass them as empty/undefined.
     * When absent the builder falls back to the synchronous literal match.
     */
    readonly coverage?: CoverageRow[];
    /** Used only when `coverage` is not provided (legacy / test path). */
    readonly jdMustHaves?: string[];
    /** Used only when `coverage` is not provided (legacy / test path). */
    readonly groundedTerms?: Set<string>;
    /** Rendered PDF page count (from parse-back); optional for the legacy/test path. */
    readonly pages?: number;
    /** JD required skills — weights the coverage score (0.7 required / 0.3 rest). */
    readonly requiredSkills?: readonly string[];
}

type Coverage = AtsCheckResult['jdKeywordCoverage'];

/** Rendered pages beyond this fail the check — industry-standard resume cap. */
export const MAX_PDF_PAGES = 2;

/** Human-readable ATS issues derived from the computed check facts. */
function deriveIssues(facts: {
    standardSectionsDetected: string[];
    nameFound: boolean;
    emailFound: boolean;
    coverage: Coverage;
    parseBreakers: string[];
    pages?: number;
}): string[] {
    const issues: string[] = [];
    const missing = REQUIRED_SECTIONS.filter(s => !facts.standardSectionsDetected.includes(s));
    if (missing.length) issues.push(`Missing standard sections: ${missing.join(', ')}.`);
    if (!facts.nameFound) issues.push('Candidate name not found in document body.');
    if (!facts.emailFound) issues.push('Contact email not found in document body.');
    for (const k of facts.coverage) {
        if (!k.present && k.grounded) issues.push(`Grounded JD must-have "${k.term}" missing from resume.`);
    }
    if (facts.parseBreakers.length) issues.push(`Parse-breaking elements detected: ${facts.parseBreakers.join(', ')}.`);
    if (typeof facts.pages === 'number' && facts.pages > MAX_PDF_PAGES) {
        issues.push(`Resume renders to ${facts.pages} pages — exceeds the ${MAX_PDF_PAGES}-page maximum.`);
    }
    return issues;
}


/** Weighted JD-keyword coverage: required terms 0.7, the rest 0.3, weighting
 *  only non-empty pools (evidence-fit convention). Undefined when there is no
 *  coverage to grade. */
function weightedCoverageScore(
    coverage: Coverage | undefined,
    requiredSkills: readonly string[] | undefined,
): number | undefined {
    if (!coverage || coverage.length === 0) return undefined;
    const required = new Set((requiredSkills ?? []).map((s) => s.trim().toLowerCase()));
    const pools = { req: { hit: 0, total: 0 }, rest: { hit: 0, total: 0 } };
    for (const row of coverage) {
        const pool = required.has(row.term.trim().toLowerCase()) ? pools.req : pools.rest;
        pool.total++;
        if (row.present) pool.hit++;
    }
    const wReq = pools.req.total > 0 ? 0.7 : 0;
    const wRest = pools.rest.total > 0 ? 0.3 : 0;
    const wSum = wReq + wRest;
    if (wSum === 0) return undefined;
    const frac = (p: { hit: number; total: number }): number => (p.total > 0 ? p.hit / p.total : 0);
    return (wReq * frac(pools.req) + wRest * frac(pools.rest)) / wSum;
}


/** Spreadable score field — keeps buildAtsCheck's complexity flat. */
function coverageScoreField(
    coverage: Coverage | undefined,
    requiredSkills: readonly string[] | undefined,
): { coverageScore?: number } {
    const score = weightedCoverageScore(coverage, requiredSkills);
    return score === undefined ? {} : { coverageScore: score };
}

/**
 * Reconcile the headline `passed` bit against the two signals that can
 * disagree (F5). `status` comes from this file's GROUNDED-keyword issue
 * count (`deriveIssues` — a missing keyword only counts when verified OR
 * partial evidence backs it). `attainablePassed` comes from
 * `splitAttainable` in attainable.ts — a stricter, VERIFIED-only pass mark
 * computed later, once the Skill Evidence Ledger is available. The two
 * measure different things on purpose and are NOT collapsed into one
 * check; this reconciler is the single arbiter of the headline `passed`
 * bit so downstream consumers never have to compare them independently.
 *
 * Precedence: both must agree to pass. `status` must be `'passed'` AND
 * `attainablePassed` must not be explicitly `false`. `attainablePassed` is
 * `undefined` before the ledger split has run (e.g. inside `buildAtsCheck`
 * itself, on first construction) — `undefined` never blocks the pass, only
 * an explicit `false` does.
 */
export function reconcileAtsPassed(
    status: AtsCheckResult['status'],
    attainablePassed: boolean | undefined,
): boolean {
    return status === 'passed' && attainablePassed !== false;
}

/** Pure ATS assertions over the parsed-back PDF + structured + JD data. */
export function buildAtsCheck(a: BuildAtsCheckArgs): AtsCheckResult {
    // No usable text → cannot assert anything; fail closed as unverified.
    if (a.text.trim().length === 0) {
        return {
            machineReadable: false, standardSectionsDetected: [],
            contactDetected: { name: '', email: '' }, parseBreakers: [],
            jdKeywordCoverage: [], status: 'unverified', passed: false,
            issues: ['Rendered PDF produced no extractable text.'],
        };
    }

    const lower = a.text.toLowerCase();
    const standardSectionsDetected = a.sections.filter(s => (STANDARD_SECTIONS as readonly string[]).includes(s));
    const nameFound = a.profile.name.trim().length > 0 && lower.includes(a.profile.name.toLowerCase());
    const emailFound = a.profile.email.trim().length > 0 && lower.includes(a.profile.email.toLowerCase());
    // Use pre-computed coverage (with tier) when available; fall back to the
    // synchronous literal match for the legacy / test path.
    const jdKeywordCoverage: Coverage = a.coverage ?? (a.jdMustHaves ?? []).map(term => ({
        term,
        present:  lower.includes(term.toLowerCase()),
        grounded: (a.groundedTerms ?? new Set()).has(term.toLowerCase()),
        tier:     lower.includes(term.toLowerCase()) ? ('literal' as const) : ('none' as const),
    }));
    // parseBreakers: by construction the layout has none. We still scan for the
    // classic tab-delimited multi-column artifact as a regression guard.
    const parseBreakers = /\t.+\t/.test(a.text) ? ['multi-column-tabs'] : [];

    const issues = deriveIssues({ standardSectionsDetected, nameFound, emailFound, coverage: jdKeywordCoverage, parseBreakers, pages: a.pages });
    const status = issues.length === 0 ? ('passed' as const) : ('issues' as const);
    // `attainablePassed` is not yet known here (the Skill Evidence Ledger
    // split runs later, in run-pipeline.ts, once the ledger is built), so
    // this is equivalent to `status === 'passed'`. run-pipeline.ts re-applies
    // reconcileAtsPassed once attainablePassed is known and re-persists the
    // updated value — see F5/F6 in checks.ts's reconcileAtsPassed doc.
    const passed = reconcileAtsPassed(status, undefined);
    return {
        machineReadable: true,
        standardSectionsDetected,
        contactDetected: { name: a.profile.name, email: a.profile.email },
        parseBreakers,
        jdKeywordCoverage,
        status,
        passed,
        issues,
        ...(typeof a.pages === 'number' ? { pageCount: a.pages } : {}),
        ...coverageScoreField(a.coverage, a.requiredSkills),
    };
}
