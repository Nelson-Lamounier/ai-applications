/**
 * @format
 * PiiScrubber — standalone redactor. Run before EVERY sink that can leak
 * PII: the LLM call, the DB write, and the log line. Deliberately separate
 * from InputSanitiser (which only warns and only sees the input flow).
 */

import { RegexPiiDetector } from './regex-pii-detector.js';
import {
    DEFAULT_REDACTION_POLICY,
    type IPiiDetector,
    type PiiSpan,
    type RedactionPolicy,
} from './pii-types.js';

export interface PiiScrubberConfig {
    /** Detector to use. Default: RegexPiiDetector. */
    readonly detector?: IPiiDetector;
    /** Mask-token policy. Default: DEFAULT_REDACTION_POLICY. */
    readonly policy?: RedactionPolicy;
}

export interface PiiScrubResult {
    readonly redacted: string;
    readonly spans: PiiSpan[];
    readonly found: boolean;
}

export class PiiScrubber {
    private readonly detector: IPiiDetector;
    private readonly policy: RedactionPolicy;

    constructor(config?: PiiScrubberConfig) {
        this.detector = config?.detector ?? new RegexPiiDetector();
        this.policy = config?.policy ?? DEFAULT_REDACTION_POLICY;
    }

    scrub(text: string): PiiScrubResult {
        const spans = [...this.detector.detect(text)].sort((a, b) => a.start - b.start);
        if (spans.length === 0) {
            return { redacted: text, spans: [], found: false };
        }
        // Apply right-to-left so earlier offsets stay valid.
        let redacted = text;
        for (let i = spans.length - 1; i >= 0; i--) {
            const sp = spans[i];
            redacted = redacted.slice(0, sp.start) + this.policy[sp.type] + redacted.slice(sp.end);
        }
        return { redacted, spans, found: true };
    }
}
