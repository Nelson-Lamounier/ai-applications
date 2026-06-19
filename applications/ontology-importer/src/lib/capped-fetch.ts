/** @format */
import { request } from 'undici';

/**
 * HTTP fetch with a request/body timeout and a hard max-response-byte cap
 * (Constitution V: network adapters that buffer responses MUST set timeouts and
 * response-size caps). The existing registry sources fetch without either; every
 * skill-import source goes through this helper instead.
 *
 * `readCapped` is the testable core — it enforces the byte cap while draining an
 * async-iterable body, so the streaming guard is unit-tested without a network.
 */

export interface CappedFetchOptions {
    /** Per-request + per-body timeout (ms). Default 30s. */
    readonly timeoutMs?: number;
    /** Hard cap on buffered response bytes. Default 64 MiB. */
    readonly maxBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Drain `body` into a Buffer, throwing once the running total exceeds `maxBytes`
 * — never buffers an unbounded response. Pure over any async iterable of chunks.
 */
export async function readCapped(
    body: AsyncIterable<Buffer | Uint8Array>,
    maxBytes: number,
): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of body) {
        total += chunk.length;
        if (total > maxBytes) {
            throw new Error(`capped-fetch: response exceeded ${maxBytes} byte cap`);
        }
        chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
}

/** Fetch a URL as UTF-8 text under a timeout + byte cap. Throws on non-2xx. */
export async function cappedFetchText(url: string, opts: CappedFetchOptions = {}): Promise<string> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

    const { statusCode, headers, body } = await request(url, {
        headersTimeout: timeoutMs,
        bodyTimeout: timeoutMs,
    });
    if (statusCode < 200 || statusCode >= 300) {
        body.destroy();
        throw new Error(`capped-fetch: ${url} returned HTTP ${statusCode}`);
    }
    // Reject early when the server declares an oversized body.
    const declared = Number(headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
        body.destroy();
        throw new Error(`capped-fetch: declared content-length ${declared} exceeds ${maxBytes} byte cap`);
    }
    return (await readCapped(body, maxBytes)).toString('utf-8');
}
