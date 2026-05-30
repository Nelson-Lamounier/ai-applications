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

interface RuleTemplate {
    readonly type: PiiType;
    readonly source: string;
    readonly flags: string;
}

const RULE_TEMPLATES: ReadonlyArray<RuleTemplate> = [
    { type: 'EMAIL', source: String.raw`\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b`, flags: 'g' },
    { type: 'SSN', source: String.raw`\b\d{3}-\d{2}-\d{4}\b`, flags: 'g' },
    { type: 'CREDIT_CARD', source: String.raw`\b(?:\d[ -]*?){13,16}\b`, flags: 'g' },
    { type: 'PHONE', source: String.raw`\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b`, flags: 'g' },
    { type: 'IP', source: String.raw`\b(?:\d{1,3}\.){3}\d{1,3}\b`, flags: 'g' },
    { type: 'NAME', source: String.raw`(?<=\b(?:name|candidate|applicant|by)\b[:\s]+)[A-Z][a-z]+ [A-Z][a-z]+`, flags: 'gi' },
];

export class RegexPiiDetector implements IPiiDetector {
    private readonly rules: ReadonlyArray<{ type: PiiType; regex: RegExp }>;

    constructor() {
        this.rules = RULE_TEMPLATES.map(({ type, source, flags }) => ({
            type,
            regex: new RegExp(source, flags),
        }));
    }

    detect(text: string): PiiSpan[] {
        const spans: PiiSpan[] = [];
        for (const { type, regex } of this.rules) {
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
