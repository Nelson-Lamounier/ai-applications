/** @format */
import { describe, it, expect, afterEach } from '@jest/globals';
import * as tar from 'tar';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { safeFilter, safeExtract } from './safeExtract.js';

describe('safeFilter', () => {
    it('accepts a normal nested file', () => {
        expect(safeFilter('root-abc/src/index.ts', { type: 'File' } as never)).toBe(true);
    });
    it('rejects path traversal (zip-slip)', () => {
        expect(safeFilter('root-abc/../../etc/passwd', { type: 'File' } as never)).toBe(false);
    });
    it('rejects symlinks and hardlinks', () => {
        expect(safeFilter('root-abc/link', { type: 'SymbolicLink' } as never)).toBe(false);
        expect(safeFilter('root-abc/link', { type: 'Link' } as never)).toBe(false);
    });
    it('rejects absolute paths', () => {
        expect(safeFilter('/etc/passwd', { type: 'File' } as never)).toBe(false);
    });
});

describe('safeExtract', () => {
    const dirs: string[] = [];
    afterEach(async () => {
        await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
    });

    async function mkTarball(rootDirName: string): Promise<{ tarballPath: string; destDir: string }> {
        const srcDir = await fs.mkdtemp(path.join(os.tmpdir(), 'safeextract-src-'));
        const destDir = await fs.mkdtemp(path.join(os.tmpdir(), 'safeextract-dest-'));
        dirs.push(srcDir, destDir);

        const rootDir = path.join(srcDir, rootDirName);
        await fs.mkdir(path.join(rootDir, 'nested'), { recursive: true });
        await fs.writeFile(path.join(rootDir, 'README.md'), '# hello');
        await fs.writeFile(path.join(rootDir, 'nested', 'file.txt'), 'nested content');

        const tarballPath = path.join(srcDir, 'archive.tar.gz');
        await tar.c({ gzip: true, file: tarballPath, cwd: srcDir }, [rootDirName]);
        return { tarballPath, destDir };
    }

    it('captures the GitHub-shaped {owner}-{repo}-{40-hex-sha} root dir and strips it', async () => {
        const sha = '2c9dacce1d3cf5ffd722b2a28021692023dea548';
        const rootDirName = `octo-repo-${sha}`;
        const { tarballPath, destDir } = await mkTarball(rootDirName);

        const result = await safeExtract(tarballPath, destDir);

        expect(result.rootDir).toBe(rootDirName);
        expect(await fs.readFile(path.join(destDir, 'README.md'), 'utf-8')).toBe('# hello');
        expect(await fs.readFile(path.join(destDir, 'nested', 'file.txt'), 'utf-8')).toBe('nested content');
    });

    it('captures a non-40-hex root dir name as-is (caller decides what to do with it)', async () => {
        const rootDirName = 'octo-repo-main';
        const { tarballPath, destDir } = await mkTarball(rootDirName);

        const result = await safeExtract(tarballPath, destDir);

        expect(result.rootDir).toBe(rootDirName);
    });
});
