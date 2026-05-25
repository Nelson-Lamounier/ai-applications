/** @format */

/** Strict normalization for alias lookup: lowercase + trim only. */
export function normalizeAlias(raw: string): string {
    return raw.toLowerCase().trim();
}

/**
 * In-memory strict resolver. Built from the alias table once per Job.
 * No fuzzy matching — near-misses are the candidate loop's job.
 */
export class OntologyResolver {
    constructor(private readonly aliasToId: Map<string, string>) {}

    /** @returns technology id, or null when the token is unknown. */
    resolve(rawName: string): string | null {
        return this.aliasToId.get(normalizeAlias(rawName)) ?? null;
    }
}
