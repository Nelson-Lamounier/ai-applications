/**
 * @format
 * IFileFilter — File Inclusion Contract
 *
 * Determines which files in a repository should be ingested.
 * Pure predicate — no I/O, no async, no side effects.
 * Implementations may use glob patterns, extension lists, or size limits.
 */

export interface IFileFilter {
    /** Returns true if this file path should be included in ingestion. */
    shouldInclude(filePath: string): boolean;

    /** Convenience: filter an array of paths to only included ones. */
    filter(filePaths: string[]): string[];
}
