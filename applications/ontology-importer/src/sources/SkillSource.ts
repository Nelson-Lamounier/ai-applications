/** @format */
import type { RawImportEntry } from '@bedrock/shared';

export type { RawImportEntry };

/**
 * A skill-vocabulary source. Like the technology `Source` but carries a
 * `licence` so the importer can reject a non-commercial-safe source before any
 * write (FR-007), and yields capability entries (mapped to the 15 skill
 * categories downstream) rather than tool entries. Fetches + parses + yields;
 * never categorises or touches the DB.
 */
export interface SkillSource {
    readonly name:    string;   // 'onet' | 'curated'
    readonly licence: string;   // 'CC-BY-4.0' | 'curated' — allowlist-checked
    /** Streamed — O*NET is large. */
    fetch(): AsyncIterable<RawImportEntry>;
}
