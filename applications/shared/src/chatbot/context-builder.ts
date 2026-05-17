import type { RetrievedPassage } from '../retrieval/index.js';

function escapeXml(s: string): string {
    return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

/** Phase 4 — Context Window Management defaults. */
export interface ChatContextOptions {
    /** Max chunks injected into the prompt. Checklist mandates top 3. */
    maxChunks?: number;
    /**
     * Hard ceiling on total context characters. ~4 chars/token, so the
     * 6000 default is ≈1.5k tokens — leaves ample headroom under model
     * limits alongside the system prompt and the user query.
     */
    maxContextChars?: number;
}

const DEFAULT_MAX_CHUNKS = 3;
const DEFAULT_MAX_CONTEXT_CHARS = 6_000;
const TRUNCATION_MARKER = ' …[truncated]';

export function buildChatContext(
    passages: RetrievedPassage[],
    opts: ChatContextOptions = {},
): string {
    if (passages.length === 0) return '<retrieved_context/>';

    const maxChunks = opts.maxChunks ?? DEFAULT_MAX_CHUNKS;
    const maxChars  = opts.maxContextChars ?? DEFAULT_MAX_CONTEXT_CHARS;

    // Order by relevance, most relevant first; never mutate the caller's array.
    const ranked = [...passages]
        .sort((a, b) => b.score - a.score)
        .slice(0, maxChunks);

    const items: string[] = [];
    let usedChars = 0;
    for (const p of ranked) {
        const remaining = maxChars - usedChars;
        if (remaining <= 0) break;

        let text = p.text;
        if (text.length > remaining) {
            // Explicit truncation — the marker guarantees no silent loss.
            text = text.slice(0, remaining) + TRUNCATION_MARKER;
        }
        usedChars += text.length;

        const uri   = escapeXml(p.sourceUri);
        const score = p.score.toFixed(2);
        const attrs = p.source === 'profile'
            ? `source="profile" repo="${uri}" score="${score}"`
            : `source="chunk" file="${uri}" score="${score}"`;
        items.push(`  <passage ${attrs}>\n    ${escapeXml(text)}\n  </passage>`);
    }

    return `<retrieved_context>\n${items.join('\n')}\n</retrieved_context>`;
}
