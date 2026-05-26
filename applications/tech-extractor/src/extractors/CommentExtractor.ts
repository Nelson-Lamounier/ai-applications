/** @format */

export interface ProseRange {
    readonly text: string;
    readonly line_start: number;
    readonly line_end: number;
}

export type ProseLang = 'typescript' | 'javascript' | 'python' | 'go';

export function extractProseRanges(src: string, lang: ProseLang | string): ProseRange[] {
    switch (lang) {
        case 'typescript':
        case 'javascript':
            return extractTs(src);
        case 'python':
            return extractPy(src);
        case 'go':
            return extractGo(src);
        default:
            return [];
    }
}

function rangeAt(
    src: string,
    matchIndex: number,
    matchText: string,
): { line_start: number; line_end: number } {
    const before = src.slice(0, matchIndex);
    const line_start = before.split('\n').length;
    const line_end = line_start + matchText.split('\n').length - 1;
    return { line_start, line_end };
}

function extractTs(src: string): ProseRange[] {
    const out: ProseRange[] = [];
    const lines = src.split('\n');
    // Line-only comments (comment-only lines, no trailing-comment support — YAGNI)
    for (let i = 0; i < lines.length; i++) {
        const m = /^\s*\/\/(.*)$/.exec(lines[i]);
        if (m) out.push({ text: m[1], line_start: i + 1, line_end: i + 1 });
    }
    // Block comments (multi-line)
    const blockRe = /\/\*([\s\S]*?)\*\//g;
    let bm: RegExpExecArray | null;
    while ((bm = blockRe.exec(src)) !== null) {
        const { line_start, line_end } = rangeAt(src, bm.index, bm[1]);
        out.push({ text: bm[1], line_start, line_end });
    }
    // Pre-compute import + require string spans to exclude
    const importSpans: Array<[number, number]> = [];
    const impRe = /\b(?:import\b[^'"`]*|require\s*\(\s*)(['"`])([^'"`]+)\1/g;
    let im: RegExpExecArray | null;
    while ((im = impRe.exec(src)) !== null) {
        const lit = im[2];
        const litEnd = im.index + im[0].length - 1;
        const litStart = litEnd - lit.length;
        importSpans.push([litStart, litStart + lit.length]);
    }
    // String literals (single, double, backtick)
    const strRe = /(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g;
    let sm: RegExpExecArray | null;
    while ((sm = strRe.exec(src)) !== null) {
        const litStart = sm.index + 1;
        const litEnd = litStart + sm[2].length;
        if (importSpans.some(([a, b]) => litStart >= a && litEnd <= b)) continue;
        if (sm[2].length === 0) continue;
        const { line_start, line_end } = rangeAt(src, litStart, sm[2]);
        out.push({ text: sm[2], line_start, line_end });
    }
    return out;
}

function extractPy(src: string): ProseRange[] {
    const out: ProseRange[] = [];
    const lines = src.split('\n');
    // # line comments (capture-after-#; don't try to ignore quoted hashes)
    for (let i = 0; i < lines.length; i++) {
        const m = /^[^#'"\n]*#(.*)$/.exec(lines[i]);
        if (m) out.push({ text: m[1], line_start: i + 1, line_end: i + 1 });
    }
    // Triple-quoted docstrings (multi-line) — emit one range per match.
    for (const re of [/"""([\s\S]*?)"""/g, /'''([\s\S]*?)'''/g]) {
        let m: RegExpExecArray | null;
        while ((m = re.exec(src)) !== null) {
            const { line_start, line_end } = rangeAt(src, m.index, m[1]);
            out.push({ text: m[1], line_start, line_end });
        }
    }
    // Per-line short string literals on non-import lines
    for (let i = 0; i < lines.length; i++) {
        if (/^\s*(import|from)\s+/.test(lines[i])) continue;
        const m = /(['"])([^'"\\\n]+)\1/.exec(lines[i]);
        if (m && m[2].length > 0) {
            if (/("""|''')/.test(lines[i])) continue;
            out.push({ text: m[2], line_start: i + 1, line_end: i + 1 });
        }
    }
    return out;
}

function extractGo(src: string): ProseRange[] {
    const out: ProseRange[] = [];
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const m = /^\s*\/\/(.*)$/.exec(lines[i]);
        if (m) out.push({ text: m[1], line_start: i + 1, line_end: i + 1 });
    }
    const blockRe = /\/\*([\s\S]*?)\*\//g;
    let bm: RegExpExecArray | null;
    while ((bm = blockRe.exec(src)) !== null) {
        const { line_start, line_end } = rangeAt(src, bm.index, bm[1]);
        out.push({ text: bm[1], line_start, line_end });
    }
    return out;
}
