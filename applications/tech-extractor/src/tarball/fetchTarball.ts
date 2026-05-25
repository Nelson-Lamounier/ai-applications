/** @format */
import { promises as fs } from 'node:fs';

export function tarballUrl(repoFullName: string, ref = 'HEAD'): string {
    return `https://api.github.com/repos/${repoFullName}/tarball/${ref}`;
}

/**
 * Download a repo tarball to `outPath`. One request per repo; fetch follows the
 * 302 to codeload automatically. Enforces a max-size cap (Content-Length) to
 * defend against runaway repos; throws `repo_too_large` past the cap.
 */
export async function fetchTarball(
    repoFullName: string,
    ref: string | undefined,
    token: string,
    outPath: string,
    maxBytes: number,
): Promise<void> {
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
}
