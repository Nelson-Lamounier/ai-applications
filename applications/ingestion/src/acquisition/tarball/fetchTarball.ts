/** @format */
import { promises as fs } from 'node:fs';

export function tarballUrl(repoFullName: string, ref = 'HEAD'): string {
    return `https://api.github.com/repos/${repoFullName}/tarball/${ref}`;
}

/** The 40-hex commit SHA from a post-redirect codeload URL's last segment, else undefined. */
export function shaFromCodeloadUrl(url: string): string | undefined {
    const last = url.split('/').pop() ?? '';
    return /^[0-9a-f]{40}$/i.test(last) ? last.toLowerCase() : undefined;
}

/**
 * The 40-hex commit SHA suffix from a tarball's captured root directory
 * name, else undefined. GitHub API tarballs name that directory
 * `{owner}-{repo}-{40-hex-sha}`; owner/repo may themselves contain hyphens,
 * so this anchors on a trailing `-<40 hex chars>` rather than splitting on
 * `-`. Fallback path used when {@link shaFromCodeloadUrl} can't parse the
 * resolved URL (see `fetchAndExtractTarball` in `run-tech-extract.ts`) — a
 * short (< 40 hex) suffix cannot be expanded to a full SHA, so this
 * deliberately returns undefined rather than a truncated value.
 */
export function shaFromRootDir(rootDir: string | null): string | undefined {
    if (!rootDir) return undefined;
    const match = /-([0-9a-f]{40})$/i.exec(rootDir);
    return match ? match[1].toLowerCase() : undefined;
}

/**
 * Download a repo tarball to `outPath`. One request per repo; fetch follows the
 * 302 to codeload automatically. Enforces a max-size cap (Content-Length) to
 * defend against runaway repos; throws `repo_too_large` past the cap.
 *
 * Returns the RESOLVED commit SHA (or undefined if it can't be parsed). GitHub
 * redirects `tarball/HEAD` to `codeload.github.com/.../legacy.tar.gz/<sha>`, so the
 * final URL's last segment is the real commit — letting callers persist a true SHA
 * instead of the literal 'HEAD' placeholder (which shadows real evidence downstream).
 */
export async function fetchTarball(
    repoFullName: string,
    ref: string | undefined,
    token: string,
    outPath: string,
    maxBytes: number,
): Promise<string | undefined> {
    const res = await fetch(tarballUrl(repoFullName, ref ?? 'HEAD'), {
        headers: {
            Authorization: `Bearer ${token}`,
            Accept:        'application/vnd.github+json',
            'User-Agent':  'tucaken-tech-extractor',
        },
        redirect: 'follow',
    });
    if (!res.ok) throw new Error(`tarball fetch failed: HTTP ${res.status}`);

    const len = Number(res.headers.get('content-length') ?? '0');
    if (len > maxBytes) throw new Error(`repo_too_large: ${len} > ${maxBytes}`);
    if (!res.body) throw new Error('tarball fetch returned no body');

    // Stream with an inline byte counter so a missing/zero Content-Length
    // can't OOM us on a huge (untrusted) body — abort as soon as we exceed cap.
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
            total += value.length;
            if (total > maxBytes) throw new Error(`repo_too_large: streamed > ${maxBytes}`);
            chunks.push(value);
        }
    }
    await fs.writeFile(outPath, Buffer.concat(chunks));
    return shaFromCodeloadUrl(res.url);
}
