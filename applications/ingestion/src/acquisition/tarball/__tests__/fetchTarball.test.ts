/** @format */
import { describe, it, expect, jest, afterEach } from '@jest/globals';
import { tarballUrl, fetchTarball, shaFromCodeloadUrl, shaFromRootDir } from '../fetchTarball.js';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('tarballUrl', () => {
    it('builds the api url for a ref', () => {
        expect(tarballUrl('owner/repo', 'main')).toBe('https://api.github.com/repos/owner/repo/tarball/main');
    });
    it('defaults ref to HEAD when omitted', () => {
        expect(tarballUrl('owner/repo')).toBe('https://api.github.com/repos/owner/repo/tarball/HEAD');
    });
});

describe('fetchTarball', () => {
    const realFetch = globalThis.fetch;
    afterEach(() => { globalThis.fetch = realFetch; });

    it('writes the response body to disk with auth + size guard', async () => {
        const body = Buffer.from('fake-tar-bytes');
        globalThis.fetch = jest.fn(async () => new Response(body, {
            status: 200, headers: { 'content-length': String(body.length) },
        })) as never;

        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tball-'));
        const out = path.join(dir, 'repo.tar.gz');
        await fetchTarball('owner/repo', 'main', 'tok', out, 1024 * 1024);

        const written = await fs.readFile(out);
        expect(written.equals(body)).toBe(true);
        const call = (globalThis.fetch as jest.Mock).mock.calls[0];
        expect((call[1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer tok' });
        await fs.rm(dir, { recursive: true, force: true });
    });

    it('rejects when content-length exceeds the cap', async () => {
        globalThis.fetch = jest.fn(async () => new Response(Buffer.from('x'), {
            status: 200, headers: { 'content-length': String(5_000_000) },
        })) as never;
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tball-'));
        await expect(
            fetchTarball('owner/repo', 'main', 'tok', path.join(dir, 'r.tar.gz'), 1_000_000),
        ).rejects.toThrow(/too large|repo_too_large/i);
        await fs.rm(dir, { recursive: true, force: true });
    });

    it('throws on non-200', async () => {
        globalThis.fetch = jest.fn(async () => new Response('nope', { status: 404 })) as never;
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tball-'));
        await expect(
            fetchTarball('owner/repo', 'main', 'tok', path.join(dir, 'r.tar.gz'), 1_000_000),
        ).rejects.toThrow(/404/);
        await fs.rm(dir, { recursive: true, force: true });
    });

    it('aborts a body that exceeds the cap when Content-Length is absent', async () => {
        const big = Buffer.alloc(2_000); // 2000 bytes, cap will be 1000
        globalThis.fetch = jest.fn(async () => new Response(big, { status: 200 })) as never;
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tball-'));
        await expect(
            fetchTarball('owner/repo', 'main', 'tok', path.join(dir, 'r.tar.gz'), 1_000),
        ).rejects.toThrow(/repo_too_large/i);
        await fs.rm(dir, { recursive: true, force: true });
    });
});

describe('shaFromCodeloadUrl', () => {
    it('extracts the 40-hex SHA from a resolved codeload URL', () => {
        expect(shaFromCodeloadUrl('https://codeload.github.com/o/r/legacy.tar.gz/2c9dacce1d3cf5ffd722b2a28021692023dea548'))
            .toBe('2c9dacce1d3cf5ffd722b2a28021692023dea548');
    });
    it('returns undefined for a non-SHA last segment (e.g. literal HEAD)', () => {
        expect(shaFromCodeloadUrl('https://api.github.com/repos/o/r/tarball/HEAD')).toBeUndefined();
        expect(shaFromCodeloadUrl('https://codeload.github.com/o/r/legacy.tar.gz/main')).toBeUndefined();
    });
});

describe('shaFromRootDir', () => {
    const sha = '2c9dacce1d3cf5ffd722b2a28021692023dea548';

    it('extracts the trailing 40-hex SHA from a GitHub-shaped {owner}-{repo}-{sha} root dir', () => {
        expect(shaFromRootDir(`octo-repo-${sha}`)).toBe(sha);
    });

    it('handles owner/repo names that themselves contain hyphens', () => {
        expect(shaFromRootDir(`my-org-my-repo-name-${sha}`)).toBe(sha);
    });

    it('lowercases a mixed-case SHA', () => {
        expect(shaFromRootDir(`octo-repo-${sha.toUpperCase()}`)).toBe(sha);
    });

    it('returns undefined for a short (non-expandable) suffix', () => {
        expect(shaFromRootDir('octo-repo-2c9dacc')).toBeUndefined();
    });

    it('returns undefined for a non-sha suffix (e.g. a branch name)', () => {
        expect(shaFromRootDir('octo-repo-main')).toBeUndefined();
    });

    it('returns undefined for null', () => {
        expect(shaFromRootDir(null)).toBeUndefined();
    });
});
