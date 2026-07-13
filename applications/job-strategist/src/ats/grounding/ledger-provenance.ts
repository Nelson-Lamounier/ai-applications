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

/**
 * Known short canonicals (< 4 chars) that must NOT be dropped by the length
 * filter below. Without this allowlist a strong KB hit for "SQL", "Go", "AWS",
 * "EKS", "IAM", "CDK", "GCP", "CI" or "CD" never earns a token to match on, so
 * the entry never gets provenance even when the passage clearly supports it.
 */
const SHORT_CANONICAL_ALLOWLIST = new Set(['sql', 'go', 'aws', 'eks', 'iam', 'cdk', 'gcp', 'ci', 'cd']);

/** Significant lowercase tokens of a tool phrase (len >= 4, non-generic, or an allowlisted short canonical). */
function toolTokens(tool: string): string[] {
    return tool
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => (t.length >= 4 || SHORT_CANONICAL_ALLOWLIST.has(t)) && !STOPWORDS.has(t));
}

const SNIPPET_CHARS = 200;

/**
 * Negation/migration phrases that flip a token hit from "supporting" to
 * "contradicting" — a passage saying "migrated away from Kubernetes" or "no
 * longer uses X" is NOT evidence the tool is currently used.
 */
const NEGATION_RE = /\b(migrated away from|no longer|deprecated|replaced|moved off|sunset)\b/i;
/** Word-window either side of the token searched for a negation phrase. */
const NEGATION_WINDOW_WORDS = 8;

/** Lowercase alnum words of `text`, in order (empty entries dropped). */
function words(text: string): string[] {
    return text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 0);
}

/**
 * True when `token` occurs in `hay` with a negation/migration phrase within
 * NEGATION_WINDOW_WORDS words either side — guards against attaching a passage
 * as "supporting" evidence when it actually describes the tool being dropped.
 */
function isNegatedMention(hay: string, token: string): boolean {
    const ws = words(hay);
    for (let i = 0; i < ws.length; i++) {
        if (!ws[i].includes(token)) continue;
        const start = Math.max(0, i - NEGATION_WINDOW_WORDS);
        const end = Math.min(ws.length, i + NEGATION_WINDOW_WORDS + 1);
        if (NEGATION_RE.test(ws.slice(start, end).join(' '))) return true;
    }
    return false;
}

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
            .map(({ p, hay }) => ({ p, hay, hits: tokens.filter((t) => hay.includes(t)).length }))
            .filter((s) => s.hits >= needed)
            // Negation guard: a passage that mentions the tool only in a
            // negation/migration context (e.g. "migrated away from Kubernetes")
            // is not supporting evidence — drop it rather than misattribute it.
            .filter((s) => !tokens.some((t) => s.hay.includes(t) && isNegatedMention(s.hay, t)))
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
