import type { RetrievedPassage } from '../retrieval/index.js';

function escapeXml(s: string): string {
    return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

export function buildChatContext(passages: RetrievedPassage[]): string {
    if (passages.length === 0) return '<retrieved_context/>';

    const items = passages.map((p) => {
        const uri   = escapeXml(p.sourceUri);
        const score = p.score.toFixed(2);
        const attrs = p.source === 'profile'
            ? `source="profile" repo="${uri}" score="${score}"`
            : `source="chunk" file="${uri}" score="${score}"`;
        return `  <passage ${attrs}>\n    ${escapeXml(p.text)}\n  </passage>`;
    });

    return `<retrieved_context>\n${items.join('\n')}\n</retrieved_context>`;
}
