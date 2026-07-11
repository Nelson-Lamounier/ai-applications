/** @format */
/**
 * Ledger passage provenance — the "how was this verified" audit trail.
 *
 * A Verified ledger entry used to show only the matcher LLM's prose citation,
 * with no way to see WHICH retrieved KB passages backed it. The passages are
 * right there in the run's own kbContext (each with source + cosine + rerank
 * headers) — this module joins them onto ledger entries deterministically so
 * the evidence panel can show source, scores, and a snippet per claim.
 *
 * Matching is intentionally conservative-but-compound-aware: a tool's
 * significant tokens are matched as lowercase substrings so camelCase
 * identifiers count ("state" ⊂ "RdsSyncStateRepository"); a multi-token tool
 * must match at least half its tokens. Pure — no I/O, no LLM.
 */
import type { SkillEvidenceEntry, SkillEvidencePassage } from '@bedrock/shared';

export interface KbPassage {
    readonly source: string;
    readonly cosine?: number;
    readonly rerank?: number;
    readonly text: string;
}

const HEADER = /^\[Source:\s*(.+?),\s*(?:Cosine:\s*([0-9.]+),\s*Rerank:\s*([0-9.]+)|Score:\s*([0-9.]+))\]/;

/** Parse an assembled kbContext (separator-joined, headered passages). */
export function parseKbPassages(kbContext: string, separator: string): KbPassage[] {
    if (!kbContext.trim()) return [];
    const out: KbPassage[] = [];
    for (const chunk of kbContext.split(separator)) {
        const trimmed = chunk.trim();
        const m = HEADER.exec(trimmed);
        if (!m) continue;
        const body = trimmed.slice(m[0].length).trim();
        out.push({
            source: m[1],
            cosine: m[2] ? Number.parseFloat(m[2]) : Number.parseFloat(m[4]),
            rerank: m[3] ? Number.parseFloat(m[3]) : undefined,
            text:   body,
        });
    }
    return out;
}

const STOPWORDS = new Set(['and', 'the', 'with', 'for', 'via', 'from', 'into', 'over', 'using', 'management', 'engineering', 'development', 'experience', 'skills']);

/** Significant lowercase tokens of a tool phrase (len >= 4, non-generic). */
function toolTokens(tool: string): string[] {
    return tool
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length >= 4 && !STOPWORDS.has(t));
}

const SNIPPET_CHARS = 200;

/**
 * Attach the top-N retrieved passages mentioning each non-gap entry's tool.
 * Gap entries are never touched (honesty invariant — a gap has no evidence).
 * Entries whose tool matches no passage keep `provenance` absent, which the
 * panel reads as "career/experience grounding, no KB passage retrieved".
 */
export function attachPassageProvenance(
    ledger: SkillEvidenceEntry[],
    passages: readonly KbPassage[],
    topN = 3,
): SkillEvidenceEntry[] {
    if (passages.length === 0) return ledger;
    const lowered = passages.map((p) => ({ p, hay: p.text.toLowerCase() }));

    return ledger.map((entry) => {
        if (entry.status === 'gap') return entry;
        const tokens = toolTokens(entry.tool);
        if (tokens.length === 0) return entry;
        const needed = Math.max(1, Math.ceil(tokens.length / 2));

        const scored = lowered
            .map(({ p, hay }) => ({ p, hits: tokens.filter((t) => hay.includes(t)).length }))
            .filter((s) => s.hits >= needed)
            .sort((a, b) => b.hits - a.hits || (b.p.cosine ?? 0) - (a.p.cosine ?? 0))
            .slice(0, topN);
        if (scored.length === 0) return entry;

        const provenance: SkillEvidencePassage[] = scored.map(({ p }) => ({
            source:  p.source,
            cosine:  p.cosine,
            rerank:  p.rerank,
            snippet: p.text.slice(0, SNIPPET_CHARS),
        }));
        return { ...entry, provenance };
    });
}
