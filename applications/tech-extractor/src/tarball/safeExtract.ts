/** @format */
import * as tar from 'tar';

interface TarEntryLike {
    type: string;
    size?: number;
}

export interface SafeExtractOptions {
    maxEntries?: number;
    maxTotalBytes?: number;
    maxFileBytes?: number;
}

export const DEFAULT_MAX_TAR_ENTRIES = 50_000;
export const DEFAULT_MAX_EXTRACTED_BYTES = Number(process.env.MAX_EXTRACTED_BYTES ?? 500 * 1024 * 1024);
export const DEFAULT_MAX_EXTRACTED_FILE_BYTES = Number(process.env.MAX_EXTRACTED_FILE_BYTES ?? 25 * 1024 * 1024);

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

function isFileEntry(entry: TarEntryLike): boolean {
    return entry.type === 'File' || entry.type === 'OldFile' || entry.type === 'ContiguousFile';
}

export function createSafeExtractFilter(options: Required<SafeExtractOptions>): (p: string, e: TarEntryLike) => boolean {
    let count = 0;
    let totalBytes = 0;

    return (entryPath: string, entry: TarEntryLike): boolean => {
        if (++count > options.maxEntries) {
            throw new Error(`too many tar entries (> ${options.maxEntries})`);
        }
        if (!safeFilter(entryPath, entry)) return false;

        if (isFileEntry(entry)) {
            const size = entry.size ?? 0;
            if (size > options.maxFileBytes) {
                throw new Error(`extracted file too large: ${entryPath} (${size} > ${options.maxFileBytes})`);
            }
            totalBytes += size;
            if (totalBytes > options.maxTotalBytes) {
                throw new Error(`extracted bytes exceeded max ${options.maxTotalBytes}`);
            }
        }

        return true;
    };
}

/**
 * Extract a downloaded tarball into `destDir` with safety filters and
 * strip-components 1 (drops the GitHub `{owner}-{repo}-{sha}/` root). Caps the
 * number of entries to defend against zip bombs.
 */
export async function safeExtract(
    tarballPath: string,
    destDir: string,
    options: SafeExtractOptions | number = {},
): Promise<void> {
    const resolvedOptions: Required<SafeExtractOptions> = {
        maxEntries:    typeof options === 'number' ? options : options.maxEntries ?? DEFAULT_MAX_TAR_ENTRIES,
        maxTotalBytes: typeof options === 'number' ? DEFAULT_MAX_EXTRACTED_BYTES : options.maxTotalBytes ?? DEFAULT_MAX_EXTRACTED_BYTES,
        maxFileBytes:  typeof options === 'number' ? DEFAULT_MAX_EXTRACTED_FILE_BYTES : options.maxFileBytes ?? DEFAULT_MAX_EXTRACTED_FILE_BYTES,
    };

    await tar.x({
        file:    tarballPath,
        cwd:     destDir,
        strip:   1,
        strict:  true,
        filter: createSafeExtractFilter(resolvedOptions),
        preserveOwner: false,
        noChmod:       true,
    } as tar.TarOptionsWithAliases & { filter: (p: string, e: TarEntryLike) => boolean });
}
