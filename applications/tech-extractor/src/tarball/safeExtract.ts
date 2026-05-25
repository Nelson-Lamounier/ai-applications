/** @format */
import * as tar from 'tar';

interface TarEntryLike { type: string }

/**
 * Per-entry guard for tar extraction. Rejects symlinks/hardlinks, absolute
 * paths, and `..` traversal (zip-slip). Path is the in-archive path BEFORE
 * strip is applied.
 */
export function safeFilter(entryPath: string, entry: TarEntryLike): boolean {
    if (entry.type === 'SymbolicLink' || entry.type === 'Link') return false;
    if (entryPath.startsWith('/')) return false;
    if (entryPath.split('/').some((seg) => seg === '..')) return false;
    return true;
}

/**
 * Extract a downloaded tarball into `destDir` with safety filters and
 * strip-components 1 (drops the GitHub `{owner}-{repo}-{sha}/` root). Caps the
 * number of entries to defend against zip bombs.
 */
export async function safeExtract(tarballPath: string, destDir: string, maxEntries = 50_000): Promise<void> {
    let count = 0;
    await tar.x({
        file:    tarballPath,
        cwd:     destDir,
        strip:   1,
        strict:  true,
        filter: (p: string, entry: TarEntryLike) => {
            if (++count > maxEntries) throw new Error(`too many tar entries (> ${maxEntries})`);
            return safeFilter(p, entry);
        },
        preserveOwner: false,
        noChmod:       true,
    } as tar.TarOptionsWithAliases & { filter: (p: string, e: TarEntryLike) => boolean });
}
