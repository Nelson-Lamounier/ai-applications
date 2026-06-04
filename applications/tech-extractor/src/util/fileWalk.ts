/** @format */
import { promises as fs } from 'node:fs';
import path from 'node:path';

const TEXT_EXT = new Set([
    '.ts','.tsx','.js','.jsx','.py','.go','.rs','.java',
    '.tf','.hcl','.yaml','.yml','.json','.toml','.md','.sh',
]);
const SPECIAL_NAMES = new Set(['dockerfile']);
export const DEFAULT_MAX_TEXT_FILE_BYTES = Number(process.env.MAX_TEXT_FILE_BYTES ?? 500 * 1024);

export interface WalkTextFilesOptions {
    maxFileBytes?: number;
}

/** Cheap extension/name filter for the text-oriented extractors. */
export function isTextCandidate(filePath: string): boolean {
    const base = path.basename(filePath).toLowerCase();
    if (SPECIAL_NAMES.has(base) || base.startsWith('dockerfile')) return true;
    return TEXT_EXT.has(path.extname(base));
}

/** Recursively list text-candidate files under root, returning repo-relative paths. */
export async function walkTextFiles(rootDir: string, options: WalkTextFilesOptions = {}): Promise<string[]> {
    const out: string[] = [];
    const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_TEXT_FILE_BYTES;
    async function rec(dir: string): Promise<void> {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const e of entries) {
            if (e.name === '.git' || e.name === 'node_modules') continue;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) { await rec(full); continue; }
            if (e.isFile() && !e.isSymbolicLink() && isTextCandidate(e.name)) {
                const stat = await fs.stat(full);
                if (stat.size <= maxFileBytes) out.push(path.relative(rootDir, full));
            }
        }
    }
    await rec(rootDir);
    return out;
}

export async function readTextFileWithinLimit(
    rootDir: string,
    rel: string,
    maxFileBytes = DEFAULT_MAX_TEXT_FILE_BYTES,
): Promise<string> {
    const root = path.resolve(rootDir);
    const full = path.resolve(root, rel);
    if (full !== root && !full.startsWith(root + path.sep)) {
        throw new Error(`unsafe file path: ${rel}`);
    }

    const stat = await fs.stat(full);
    if (stat.size > maxFileBytes) {
        throw new Error(`file too large: ${rel} (${stat.size} > ${maxFileBytes})`);
    }
    return fs.readFile(full, 'utf-8');
}
