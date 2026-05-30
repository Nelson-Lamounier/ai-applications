/**
 * @format
 * PII types — shared contract for detection + redaction.
 *
 * Mirrors the storage-agnostic IReranker pattern: one interface, swappable
 * implementations.
 *
 * Implementations:
 *   - RegexPiiDetector — deterministic, zero-infra default
 *   - ComprehendPiiDetector — Amazon Comprehend; higher recall (stub for now)
 *
 * Failure semantics are implementation-defined: RegexPiiDetector returns []
 * on input it cannot match; the Comprehend stub throws until implemented.
 * Callers should not assume detect() never throws.
 */

export type PiiType =
    | 'EMAIL'
    | 'PHONE'
    | 'SSN'
    | 'CREDIT_CARD'
    | 'IP'
    | 'NAME';

export interface PiiSpan {
    /** Inclusive start offset in the source string. */
    readonly start: number;
    /** Exclusive end offset in the source string. */
    readonly end: number;
    readonly type: PiiType;
    /** The matched substring (for logging/tests; never re-emitted to sinks). */
    readonly value: string;
}

/** Maps each PII type to its mask token. */
export type RedactionPolicy = Readonly<Record<PiiType, string>>;

export const DEFAULT_REDACTION_POLICY: RedactionPolicy = {
    EMAIL: '[EMAIL]',
    PHONE: '[PHONE]',
    SSN: '[SSN]',
    CREDIT_CARD: '[CC]',
    IP: '[IP]',
    NAME: '[NAME]',
};

export interface IPiiDetector {
    /** Return all PII spans found in `text`, in ascending start order. */
    detect(text: string): PiiSpan[];
}
