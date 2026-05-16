/**
 * @format
 * RegexPiiDetector — deterministic, zero-infra default IPiiDetector.
 *
 * Best-effort. The NAME heuristic is deliberately low-recall (only
 * capitalised bigrams adjacent to a name-context keyword) to avoid
 * over-redacting ordinary capitalised phrases. ML-grade name detection
 * is the ComprehendPiiDetector's job (see GitHub issue).
 */

import type { IPiiDetector, PiiSpan, PiiType } from './pii-types.js';

interface Rule {
    readonly type: PiiType;
    readonly regex: RegExp;
}

const RULES: ReadonlyArray<Rule> = [
    { type: 'EMAIL', regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
    { type: 'SSN', regex: /\b\d{3}-\d{2}-\d{4}\b/g },
    { type: 'CREDIT_CARD', regex: /\b(?:\d[ -]*?){13,16}\b/g },
    { type: 'PHONE', regex: /\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/g },
    { type: 'IP', regex: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g },
    { type: 'NAME', regex: /(?<=\b(?:name|candidate|applicant|by)\b[:\s]+)[A-Z][a-z]+ [A-Z][a-z]+/gi },
];

export class RegexPiiDetector implements IPiiDetector {
    detect(text: string): PiiSpan[] {
        const spans: PiiSpan[] = [];
        for (const { type, regex } of RULES) {
            regex.lastIndex = 0;
            let m: RegExpExecArray | null;
            while ((m = regex.exec(text)) !== null) {
                spans.push({ start: m.index, end: m.index + m[0].length, type, value: m[0] });
                if (m[0].length === 0) regex.lastIndex++;
            }
        }
        return spans.sort((a, b) => a.start - b.start);
    }
}
