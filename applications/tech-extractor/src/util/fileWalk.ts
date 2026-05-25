/** @format */
import { promises as fs } from 'node:fs';
import path from 'node:path';

const TEXT_EXT = new Set([
    '.ts','.tsx','.js','.jsx','.py','.go','.rs','.java',
    '.tf','.hcl','.yaml','.yml','.json','.toml','.md','.sh',
]);
const SPECIAL_NAMES = new Set(['dockerfile']);

/** Cheap extension/name filter for the text-oriented extractors. */
export function isTextCandidate(filePath: string): boolean {
    const base = path.basename(filePath).toLowerCase();
    if (SPECIAL_NAMES.has(base) || base.startsWith('dockerfile')) return true;
    return TEXT_EXT.has(path.extname(base));
}

/** Recursively list text-candidate files under root, returning repo-relative paths. */
export async function walkTextFiles(rootDir: string): Promise<string[]> {
    const out: string[] = [];
    async function rec(dir: string): Promise<void> {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const e of entries) {
            if (e.name === '.git' || e.name === 'node_modules') continue;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) { await rec(full); continue; }
            if (e.isFile() && isTextCandidate(e.name)) out.push(path.relative(rootDir, full));
        }
    }
    await rec(rootDir);
    return out;
}
