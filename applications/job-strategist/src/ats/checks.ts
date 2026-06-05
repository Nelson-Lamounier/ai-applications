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

/** Pure ATS assertions over the parsed-back PDF + structured + JD data. */
export function buildAtsCheck(a: BuildAtsCheckArgs): AtsCheckResult {
    const machineReadable = a.text.trim().length > 0;

    // No usable text → cannot assert anything; fail closed as unverified.
    if (!machineReadable) {
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

    const jdKeywordCoverage = a.jdMustHaves.map(term => ({
        term,
        present:  lower.includes(term.toLowerCase()),
        grounded: a.groundedTerms.has(term.toLowerCase()),
    }));

    // parseBreakers: by construction the layout has none. We still scan for the
    // classic tab-delimited multi-column artifact as a regression guard.
    const parseBreakers: string[] = [];
    if (/\t.+\t/.test(a.text)) parseBreakers.push('multi-column-tabs');

    const issues: string[] = [];
    const missingSections = REQUIRED_SECTIONS.filter(s => !standardSectionsDetected.includes(s));
    if (missingSections.length) issues.push(`Missing standard sections: ${missingSections.join(', ')}.`);
    if (!nameFound) issues.push('Candidate name not found in document body.');
    if (!emailFound) issues.push('Contact email not found in document body.');
    for (const k of jdKeywordCoverage) {
        if (!k.present && k.grounded) issues.push(`Grounded JD must-have "${k.term}" missing from resume.`);
    }
    if (parseBreakers.length) issues.push(`Parse-breaking elements detected: ${parseBreakers.join(', ')}.`);

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
