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

/** Return shape of {@link safeExtract} — see its doc comment for `rootDir`. */
export interface SafeExtractResult {
    /**
     * The tarball's top-level directory name, captured from the first
     * archive entry BEFORE strip-components drops it (GitHub API tarballs
     * name it `{owner}-{repo}-{40-hex-sha}`) — `null` when the archive had no
     * entries at all. Callers use this to recover the commit SHA when the
     * codeload redirect URL couldn't be parsed (see `fetchAndExtractTarball`
     * in `run-tech-extract.ts`).
     */
    readonly rootDir: string | null;
}

/**
 * Extract a downloaded tarball into `destDir` with safety filters and
 * strip-components 1 (drops the GitHub `{owner}-{repo}-{sha}/` root). Caps the
 * number of entries to defend against zip bombs. Also captures that dropped
 * root directory name — see {@link SafeExtractResult}.
 */
export async function safeExtract(tarballPath: string, destDir: string, maxEntries = 50_000): Promise<SafeExtractResult> {
    let count = 0;
    let rootDir: string | null = null;
    await tar.x({
        file:    tarballPath,
        cwd:     destDir,
        strip:   1,
        strict:  true,
        filter: (p: string, entry: TarEntryLike) => {
            if (++count > maxEntries) throw new Error(`too many tar entries (> ${maxEntries})`);
            if (rootDir === null) {
                const first = p.split('/')[0];
                if (first) rootDir = first;
            }
            return safeFilter(p, entry);
        },
        preserveOwner: false,
        noChmod:       true,
    } as tar.TarOptionsWithAliases & { filter: (p: string, e: TarEntryLike) => boolean });
    return { rootDir };
}
