/**
 * @format
 * Security Module — Barrel Export
 *
 * Public API for the shared security module. All consumers should
 * import from this barrel rather than from individual files.
 *
 * @example
 * ```typescript
 * import { InputSanitiser, OutputSanitiser } from '@bedrock/shared/security';
 * ```
 */

export { InputSanitiser, InputSanitisationError } from './input-sanitiser.js';
export type { InputSanitiserConfig } from './input-sanitiser.js';
export { OutputSanitiser } from './output-sanitiser.js';
export type { OutputSanitiserConfig } from './output-sanitiser.js';
export type {
    InputPattern,
    OutputRedactionRule,
    PiiPattern,
    SanitiseInputResult,
    SanitisationResult,
} from './types.js';

export { PiiScrubber } from './pii-scrubber.js';
export type { PiiScrubberConfig, PiiScrubResult } from './pii-scrubber.js';
export { RegexPiiDetector } from './regex-pii-detector.js';
export { ComprehendPiiDetector } from './comprehend-pii-detector.js';
export { DEFAULT_REDACTION_POLICY } from './pii-types.js';
export type { IPiiDetector, PiiSpan, PiiType, RedactionPolicy } from './pii-types.js';
