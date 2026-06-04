/**
 * @format
 * Prose-quality linter contract. A flag-only critic that scores prose against the
 * forked stop-slop rules and lists AI-tell issues. Mirrors the grounding contract:
 * config → lint() → structured result + cost context. Never mutates input.
 */

/** Register hint per section — lets the model calibrate (business-formal advice
 *  prose should not be flagged the way resume prose is). */
export type ProseRegister = 'resume-prose' | 'storytelling' | 'advice' | 'narrative';

/** Reserved for a future 'block' mode; only 'flag' is implemented in v1. */
export type ProseLinterMode = 'flag';

export interface ProseSection {
    /** Stable locator, e.g. "jdTalkingPoints[2]" or "behaviouralQuestions[1].answerFramework". */
    readonly location: string;
    readonly register: ProseRegister;
    readonly text: string;
}

export interface ProseQualityInput {
    readonly sections: readonly ProseSection[];
    /** Context hint only (does not change rules). */
    readonly stage?: string;
}

export interface ProseIssue {
    readonly category: 'phrase' | 'structure';
    /** The offending text span. */
    readonly match: string;
    /** Which section it occurred in (mirrors ProseSection.location). */
    readonly location: string;
    readonly severity: 'high' | 'medium' | 'low';
    /** Which rule fired, e.g. "Throat-Clearing Openers" or "Binary Contrasts". */
    readonly rule: string;
}

export interface ProseScore {
    readonly directness: number;   // each 1..10
    readonly rhythm: number;
    readonly trust: number;
    readonly authenticity: number;
    readonly density: number;
    readonly total: number;        // sum, 5..50
}

export interface ProseQualityResult {
    readonly status: 'PASS' | 'FAIL';
    readonly score: ProseScore;
    readonly belowThreshold: boolean;
    readonly issues: readonly ProseIssue[];
}

export interface IProseLinter {
    lint(input: ProseQualityInput): Promise<ProseQualityResult>;
}
