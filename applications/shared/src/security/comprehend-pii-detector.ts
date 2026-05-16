/**
 * @format
 * ComprehendPiiDetector — placeholder for Amazon Comprehend DetectPiiEntities.
 *
 * Implements IPiiDetector so apps can swap detectors without rewiring.
 * NOT implemented in sub-project 1 — tracked by the shared PII GitHub issue.
 */

import type { IPiiDetector, PiiSpan } from './pii-types.js';

export class ComprehendPiiDetector implements IPiiDetector {
    detect(_text: string): PiiSpan[] {
        throw new Error(
            'ComprehendPiiDetector not implemented — see the shared PII scrubber ' +
            'GitHub issue. Use RegexPiiDetector until Comprehend is wired in.',
        );
    }
}
