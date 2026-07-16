/** @format */
/**
 * Deterministic pitch stamp for a resume project entry's `description` --
 * the SOLE source of description truth (decision from live evidence, run
 * 1eda06eb): the shipped description was the stored `projects.pitch`
 * opening PLUS guard-repair-injected technical sentences duplicating the
 * entry's own bullets, because rewrite.ts's old "three-beat" recipe (pitch +
 * differentiator + metric) kept blending pitch with bullet content and
 * revalidate kept re-flagging it. The contract now: description = human
 * what/does/why/problem language from the STORED `projects.pitch`, verbatim
 * (never re-authored by any agent or repair pass); highlights remain the
 * only JD-custom surface. Every path that produces the field calls this
 * SAME function: the Projects agent's success path (run-pipeline.ts,
 * stampProjectDescriptions) and the deterministic fallback
 * (projects-ats-flow.ts, rankProjectEntry -- which also serves the
 * reconciler's refuse-empty projects fallback). Downstream passes that CAN
 * rewrite the field (guard repair, migration reframe -- whose proseSurfaces
 * explicitly scans projects[].description -- length, metric weave,
 * revalidate, surface_keywords) are all reverted by
 * withProjectsDescriptionLock (experience-lock.ts).
 */

/** Word count, whitespace-split, empty-safe. */
function words(text: string): number {
    return text.trim().split(/\s+/).filter((w) => w.length > 0).length;
}

/**
 * Keep the first sentences of `text` up to `capWords` -- never cuts mid-
 * sentence. A single sentence longer than the cap is truncated at the word
 * boundary rather than let it defeat the trim (mirrors the length-budget
 * hard-trim approach, ats/length/length-budget.ts's `trimSentences`).
 */
function trimSentences(text: string, capWords: number): string {
    const sentences = text.split(/(?<=[.!?])\s+/);
    const kept: string[] = [];
    let count = 0;
    for (const s of sentences) {
        const w = words(s);
        if (kept.length > 0 && count + w > capWords) break;
        kept.push(s);
        count += w;
    }
    let out = kept.join(' ').trim();
    if (words(out) > capWords) {
        out = out.split(/\s+/).slice(0, capWords).join(' ').replace(/[,;:.]?$/, '.');
    }
    return out;
}

/**
 * Stamp a resume project entry's `description` from the stored project
 * `pitch`: the first PARAGRAPH only (split on a blank line -- a pitch with
 * multiple paragraphs may keep internal notes or alternate framings after
 * the first), then sentence-trimmed to `capWords` (never mid-sentence).
 *
 * Empty or missing pitch returns `''` -- fail-open, the caller must leave
 * the entry's EXISTING description untouched rather than blank it.
 */
export function stampProjectDescription(pitch: string, capWords = 80): string {
    const trimmedPitch = pitch.trim();
    if (trimmedPitch.length === 0) return '';
    const firstParagraph = trimmedPitch.split(/\n\s*\n/)[0]?.trim() ?? '';
    if (firstParagraph.length === 0) return '';
    return trimSentences(firstParagraph, capWords);
}
