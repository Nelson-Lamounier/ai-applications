/**
 * @format
 * Pure QA-phase scoring ("judge the judge"). No I/O.
 *
 * The QA agent's job is to CATCH defects and PASS clean articles. This eval
 * feeds it golden cases — one clean, the rest each carrying a single planted
 * defect in a known dimension — and asserts the QA agent flags the right
 * dimension (correct phase focus) without crying wolf on the clean one. The
 * gated runner (run-qa-eval.ts) supplies real QaValidationResults; this module
 * decides detection and aggregates.
 */
import type { QaValidationResult } from '@bedrock/shared';

export type QaDimensionKey =
    | 'technicalAccuracy'
    | 'seoCompliance'
    | 'mdxStructure'
    | 'metadataQuality'
    | 'contentQuality';

export interface QaGoldenCase {
    readonly id: string;
    /** The dimension the planted defect lives in, or 'none' for the clean control. */
    readonly expectedFlag: QaDimensionKey | 'none';
}

export interface QaCaseResult {
    readonly id: string;
    readonly expectedFlag: QaDimensionKey | 'none';
    /** Did the QA agent behave correctly for this case? */
    readonly detected: boolean;
    readonly recommendation: QaValidationResult['recommendation'];
    /** Score of the expected dimension (null for the clean control). */
    readonly flaggedDimensionScore: number | null;
}

/**
 * A dimension is "flagged" when it scores below `dimThreshold` or carries an
 * error-severity issue. The clean control is correct when nothing is flagged and
 * the recommendation is 'publish'. A planted defect is detected when its
 * dimension is flagged (regardless of the headline recommendation — phase focus
 * is what we grade).
 */
export function scoreQaCase(
    c: QaGoldenCase,
    result: QaValidationResult,
    dimThreshold = 70,
): QaCaseResult {
    const dims = result.dimensions;
    const isFlagged = (key: QaDimensionKey): boolean => {
        const d = dims[key];
        return d.score < dimThreshold || d.issues.some((i) => i.severity === 'error');
    };

    if (c.expectedFlag === 'none') {
        const anyFlagged = (Object.keys(dims) as QaDimensionKey[]).some(isFlagged);
        return {
            id: c.id,
            expectedFlag: 'none',
            detected: !anyFlagged && result.recommendation === 'publish',
            recommendation: result.recommendation,
            flaggedDimensionScore: null,
        };
    }

    return {
        id: c.id,
        expectedFlag: c.expectedFlag,
        detected: isFlagged(c.expectedFlag),
        recommendation: result.recommendation,
        flaggedDimensionScore: dims[c.expectedFlag].score,
    };
}

export interface QaEvalReport {
    readonly caseCount: number;
    readonly detectedCount: number;
    /** Fraction of cases handled correctly (defects caught + clean passed). */
    readonly accuracy: number;
    readonly perCase: ReadonlyArray<QaCaseResult>;
}

export function aggregate(results: ReadonlyArray<QaCaseResult>): QaEvalReport {
    const detectedCount = results.filter((r) => r.detected).length;
    return {
        caseCount:     results.length,
        detectedCount,
        accuracy:      results.length === 0 ? 0 : detectedCount / results.length,
        perCase:       results,
    };
}

export function passesGate(report: QaEvalReport, minAccuracy: number): boolean {
    return report.accuracy >= minAccuracy;
}

export function formatReport(report: QaEvalReport): string {
    const rows = report.perCase.map((r) =>
        `| ${r.id} | ${r.expectedFlag} | ${r.detected ? '✓' : '✗'} | ${r.recommendation} | ${r.flaggedDimensionScore ?? '—'} |`,
    );
    return [
        `QA-phase eval — ${report.detectedCount}/${report.caseCount} handled correctly (accuracy ${(report.accuracy * 100).toFixed(0)}%)`,
        '',
        '| case | expected flag | correct | recommendation | dim score |',
        '| --- | --- | --- | --- | --- |',
        ...rows,
    ].join('\n');
}
