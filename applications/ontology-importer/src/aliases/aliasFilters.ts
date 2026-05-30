/** @format */

export interface AliasPartition { insertable: string[]; collisions: string[] }

/**
 * @param aliases       candidate aliases (lowercased)
 * @param technologyId  the tech these aliases belong to
 * @param existing      alias -> technology_id map (current technology_aliases)
 */
export function partitionAliases(aliases: string[], technologyId: string, existing: Map<string, string>): AliasPartition {
    const insertable: string[] = [];
    const collisions: string[] = [];
    for (const a of aliases) {
        const owner = existing.get(a);
        if (owner === undefined) insertable.push(a);          // free
        else if (owner === technologyId) continue;            // already ours — no-op
        else collisions.push(a);                              // owned by a different tech
    }
    return { insertable, collisions };
}
