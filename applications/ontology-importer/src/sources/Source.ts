/** @format */
import type { RawImportEntry } from '@bedrock/shared';

export type { RawImportEntry };

/** A registry integration. Fetches + parses + yields; never categorizes or touches the DB. */
export interface Source {
    readonly name:      string;   // 'aws_botocore', 'npm_top_5k', ...
    readonly ecosystem: string;   // 'aws', 'npm', 'pypi', ...
    /** Streamed — sources may be large. */
    fetch(): AsyncIterable<RawImportEntry>;
    /** Source-specific category from native metadata (Layer 3), or null. */
    mapMetadataToCategory?(entry: RawImportEntry): import('@bedrock/shared').OntologyCategory | null;
    /** Source-specific pre-filter: true = keep. */
    keep?(entry: RawImportEntry): boolean;
}
