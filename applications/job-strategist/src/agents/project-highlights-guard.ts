/**
 * @format
 * Deterministic grader for the projects[].highlights section (CLAUDE.md §5).
 *
 * The Strategist populates each project's `highlights` by SELECTING from the
 * per-angle PROJECT RESUME BULLETS evidence block (see
 * `loadProjectResumeBulletsBlock`). Good output means:
 *
 *   1. Every project that HAS bullets in the block carries 2-4 highlights —
 *      the section is no longer a single thin prose blob.
 *   2. Every highlight is GROUNDED in that project's block bullets — the writer
 *      quotes/trims rather than inventing facts (the historical failure mode was
 *      the writer re-summarising and dropping the strongest technical signal).
 *   3. The JD's grounded must-have skills that the bullets DO support actually
 *      surface in the highlights (this is what lifts ATS grounded coverage).
 *
 * Pure + synchronous so it gates CI without a live model call — the fixtures in
 * the companion eval feed real-shaped data.
 */

/** A single "## <name>" group parsed out of the PROJECT RESUME BULLETS block. */
interface BlockGroup {
    readonly nameKey: string;
    readonly text: string;
    readonly words: ReadonlySet<string>;
}

export interface ProjectHighlightsGrade {
    readonly pass: boolean;
    readonly reasons: readonly string[];
    readonly totalProjects: number;
    readonly projectsWithHighlights: number;
    /** Highlights whose content words are not backed by the block — likely invented. */
    readonly ungroundedHighlights: readonly string[];
    /** Grounded must-haves (present in the block) that actually reached the highlights. */
    readonly mustHavesSurfaced: readonly string[];
    /** Grounded must-haves the block supports but that never reached the highlights. */
    readonly mustHavesMissed: readonly string[];
}

const CONTENT_WORD = /[a-z0-9][a-z0-9+.#/-]{2,}/g;

/** Lowercase, keep tech tokens (c++, ci/cd, node16); split into content words ≥3 chars. */
function contentWords(text: string): string[] {
    return text.toLowerCase().match(CONTENT_WORD) ?? [];
}

/** Glue words that carry no grounding signal — excused from the invention check. */
const STOPWORDS = new Set([
    'the', 'and', 'for', 'with', 'via', 'from', 'into', 'that', 'this', 'their',
    'across', 'each', 'per', 'onto', 'over', 'under', 'using', 'used', 'built',
    'built-in', 'through', 'without', 'while', 'when', 'which', 'where', 'both',
]);

/** Parse the block into "## <name>" groups. Bullets under each accumulate as text. */
function parseBlock(block: string): BlockGroup[] {
    const groups: BlockGroup[] = [];
    let name: string | null = null;
    let lines: string[] = [];
    const flush = (): void => {
        if (name !== null) {
            const text = lines.join('\n');
            groups.push({ nameKey: name.toLowerCase(), text, words: new Set(contentWords(text)) });
        }
    };
    for (const raw of block.split('\n')) {
        const heading = raw.match(/^##\s+(.+)$/);
        if (heading) {
            flush();
            name = heading[1].trim();
            lines = [];
        } else if (name !== null && raw.trim().startsWith('- ')) {
            lines.push(raw.trim().slice(2));
        }
    }
    flush();
    return groups;
}

/** Best-matching block group for a resume project name (exact, then prefix/substring). */
function matchGroup(groups: BlockGroup[], projectName: string): BlockGroup | undefined {
    const key = projectName.toLowerCase().trim();
    return groups.find((g) => g.nameKey === key)
        ?? groups.find((g) => g.nameKey.includes(key) || key.includes(g.nameKey));
}

interface Thresholds { readonly minPer: number; readonly maxPer: number; readonly tolerance: number }

/** Is a highlight ungrounded (too many content words absent from its block group)? */
function isUngrounded(highlight: string, group: BlockGroup, tolerance: number): { ungrounded: boolean; novel: string[] } {
    const words = contentWords(highlight).filter((w) => !STOPWORDS.has(w));
    if (words.length === 0) return { ungrounded: false, novel: [] };
    const novel = words.filter((w) => !group.words.has(w));
    return { ungrounded: novel.length / words.length > tolerance, novel };
}

/** Grade one project against its block group, appending any findings. */
function gradeProject(
    project: { name: string; highlights?: readonly string[] },
    group: BlockGroup,
    t: Thresholds,
    reasons: string[],
    ungrounded: string[],
): void {
    const highlights = project.highlights ?? [];
    if (highlights.length < t.minPer) {
        reasons.push(`"${project.name}": ${highlights.length} highlight(s), expected ≥${t.minPer} (block has evidence).`);
        return;
    }
    if (highlights.length > t.maxPer) {
        reasons.push(`"${project.name}": ${highlights.length} highlights, expected ≤${t.maxPer}.`);
    }
    for (const h of highlights) {
        const { ungrounded: bad, novel } = isUngrounded(h, group, t.tolerance);
        if (bad) {
            ungrounded.push(h);
            reasons.push(`"${project.name}": highlight not grounded in block (novel: ${novel.slice(0, 6).join(', ')}) — possible invention.`);
        }
    }
}

/** Check that block-supported must-haves surface in the highlights text. */
function gradeMustHaves(
    mustHaves: readonly string[],
    highlightsText: string,
    blockText: string,
    reasons: string[],
): { surfaced: string[]; missed: string[] } {
    const surfaced: string[] = [];
    const missed: string[] = [];
    for (const mh of mustHaves) {
        const needle = mh.toLowerCase();
        if (!blockText.includes(needle)) continue; // block can't support it — not the writer's fault
        if (highlightsText.includes(needle)) surfaced.push(mh);
        else { missed.push(mh); reasons.push(`grounded must-have "${mh}" is in the block but absent from highlights.`); }
    }
    return { surfaced, missed };
}

/**
 * Grade the projects section. `pass` is true only when every project backed by
 * block bullets carries 2-4 grounded highlights and all block-supported
 * must-haves surface.
 */
export function gradeProjectHighlights(
    projects: ReadonlyArray<{ name: string; highlights?: readonly string[] }>,
    bulletsBlock: string,
    opts: { groundedMustHaves?: readonly string[]; minPerProject?: number; maxPerProject?: number; noveltyTolerance?: number } = {},
): ProjectHighlightsGrade {
    const t: Thresholds = { minPer: opts.minPerProject ?? 2, maxPer: opts.maxPerProject ?? 4, tolerance: opts.noveltyTolerance ?? 0.2 };
    const groups = parseBlock(bulletsBlock);
    const reasons: string[] = [];
    const ungrounded: string[] = [];

    for (const p of projects) {
        const group = matchGroup(groups, p.name);
        // A project with no block evidence may legitimately omit highlights.
        if (group) gradeProject(p, group, t, reasons, ungrounded);
    }

    const highlightsText = projects.flatMap((p) => p.highlights ?? []).join(' \n ').toLowerCase();
    const blockText = groups.map((g) => g.text).join(' \n ').toLowerCase();
    const { surfaced, missed } = gradeMustHaves(opts.groundedMustHaves ?? [], highlightsText, blockText, reasons);

    return {
        pass: reasons.length === 0,
        reasons,
        totalProjects: projects.length,
        projectsWithHighlights: projects.filter((p) => (p.highlights ?? []).length > 0).length,
        ungroundedHighlights: ungrounded,
        mustHavesSurfaced: surfaced,
        mustHavesMissed: missed,
    };
}
