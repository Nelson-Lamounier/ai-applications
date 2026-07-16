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
 *
 * Empty-pitch edge (G3): a project with no `pitch` at all previously shipped
 * an empty description even when the project had a short `tagline`. The
 * source now falls back `pitch -> tagline -> ''` -- pitch wins whenever it is
 * non-empty (it is the richer, human-authored text); `tagline` (a much
 * shorter one-liner) is used only when pitch is empty/whitespace-only; both
 * empty stays `''`, unchanged from before. Both callers (`stampProjectDescriptions`
 * in run-pipeline.ts, `rankProjectEntry` in projects-ats-flow.ts) now pass
 * the pool entry's `tagline` alongside `pitch` -- the fallback lives HERE,
 * inside the stamp, so there is one source of the fallback order rather than
 * each caller re-deriving it.
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
 * `pitch`, falling back to `tagline` when `pitch` is empty/whitespace-only
 * (G3 empty-pitch edge -- see the file header comment): whichever source
 * wins, only its first PARAGRAPH is used (split on a blank line -- a pitch
 * with multiple paragraphs may keep internal notes or alternate framings
 * after the first), then sentence-trimmed to `capWords` (never mid-sentence).
 *
 * Both empty returns `''` -- fail-open, the caller must leave the entry's
 * EXISTING description untouched rather than blank it.
 */
export function stampProjectDescription(pitch: string, tagline = '', capWords = 80): string {
    const trimmedPitch = pitch.trim();
    const source = trimmedPitch.length > 0 ? trimmedPitch : tagline.trim();
    if (source.length === 0) return '';
    const firstParagraph = source.split(/\n\s*\n/)[0]?.trim() ?? '';
    if (firstParagraph.length === 0) return '';
    return trimSentences(firstParagraph, capWords);
}
