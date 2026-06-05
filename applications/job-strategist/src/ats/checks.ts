/** @format */
import type { AtsCheckResult } from './ats-check.schema.js';
import { STANDARD_SECTIONS } from './parse-back.js';

const REQUIRED_SECTIONS = ['Experience', 'Skills', 'Education'] as const;

export interface BuildAtsCheckArgs {
    readonly text: string;
    readonly sections: string[];
    readonly profile: { name: string; email: string };
    readonly jdMustHaves: string[];
    readonly groundedTerms: Set<string>;
}

type Coverage = AtsCheckResult['jdKeywordCoverage'];

/** Human-readable ATS issues derived from the computed check facts. */
function deriveIssues(facts: {
    standardSectionsDetected: string[];
    nameFound: boolean;
    emailFound: boolean;
    coverage: Coverage;
    parseBreakers: string[];
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
    return issues;
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
    const jdKeywordCoverage: Coverage = a.jdMustHaves.map(term => ({
        term,
        present:  lower.includes(term.toLowerCase()),
        grounded: a.groundedTerms.has(term.toLowerCase()),
    }));
    // parseBreakers: by construction the layout has none. We still scan for the
    // classic tab-delimited multi-column artifact as a regression guard.
    const parseBreakers = /\t.+\t/.test(a.text) ? ['multi-column-tabs'] : [];

    const issues = deriveIssues({ standardSectionsDetected, nameFound, emailFound, coverage: jdKeywordCoverage, parseBreakers });
    const passed = issues.length === 0;
    return {
        machineReadable: true,
        standardSectionsDetected,
        contactDetected: { name: a.profile.name, email: a.profile.email },
        parseBreakers,
        jdKeywordCoverage,
        status: passed ? 'passed' : 'issues',
        passed,
        issues,
    };
}
