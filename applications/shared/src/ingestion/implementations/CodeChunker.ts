/**
 * @format
 * CodeChunker — structure-aware IChunker for source code
 *
 * Replaces the blind line-window split of DefaultChunker for the languages a
 * code portfolio actually contains (TypeScript/TSX/JS/JSX, Python). The goal is
 * the one the line-window splitter cannot meet: never cut through the middle of
 * a top-level symbol. A function or class lands whole in a single chunk, so a
 * retrieved chunk is a coherent unit of code rather than an arbitrary 80-line
 * window that begins on a dangling `});`.
 *
 * Strategy:
 *   1. Mask strings and comments so braces/indent inside them never fool the
 *      boundary detector.
 *   2. Find SAFE split points — for brace languages, lines where nesting depth
 *      is 0 (between top-level symbols); for Python, lines that start in column
 *      0 (top-level def/class/statement).
 *   3. Greedily pack whole top-level units into chunks up to `maxChars`.
 *   4. A single unit larger than `maxChars` (a giant function) is sub-split on
 *      blank lines, then — only if still oversized — on raw line windows. This
 *      degrades gracefully and never drops a line.
 *
 * Anything this chunker cannot classify falls back to DefaultChunker via the
 * ChunkerRegistry — CodeChunker only claims the extensions it understands.
 *
 * Pure — no I/O, no async, no side effects (honours the IChunker contract).
 *
 * Scaling: per-language behaviour is selected by `languageOf()`. Adding a
 * language means adding one entry there plus, if its boundaries are neither
 * brace- nor indent-based, one masking branch — the packing/sizing logic is
 * shared. A future tree-sitter strategy could replace `findUnits` for a single
 * language without touching the interface or the registry.
 */

import type { RawChunk } from '../../rds/types.js';
import type { IChunker } from '../interfaces/IChunker.js';

type Language = 'brace' | 'python';

const BRACE_EXTENSIONS = new Set([
    // JS/TS family
    'ts', 'tsx', 'js', 'jsx', 'mts', 'cts', 'mjs', 'cjs',
    // other C-family / brace-delimited languages — same top-level boundary model
    'go', 'rs', 'java', 'kt', 'kts', 'scala',
    'cs', 'cpp', 'cc', 'cxx', 'c', 'h', 'hpp', 'swift', 'php',
]);
const PYTHON_EXTENSIONS = new Set(['py', 'pyi']);

export interface CodeChunkerConfig {
    /** Soft size target per chunk in characters. Default: 2400. */
    readonly maxChars: number;
    /** Trailing chunks smaller than this are merged into the previous. Default: 80. */
    readonly minChars: number;
}

const DEFAULT_CONFIG: CodeChunkerConfig = {
    maxChars: 2400,
    minChars: 80,
};

/**
 * A single top-level symbol is kept whole even when it exceeds `maxChars`;
 * only a symbol larger than `maxChars * HARD_FACTOR` is force-split. Coherence
 * of a complete function/class beats hitting the size target exactly.
 */
const HARD_FACTOR = 4;

/** A contiguous, atomic span of source lines (a whole top-level symbol). */
interface Unit {
    readonly lines: string[];
    readonly start: number;
    /**
     * True when this span is a piece of a single symbol too large to keep whole
     * (a class exceeding `maxChars * HARD_FACTOR`). Such pieces are split on
     * blank lines, so — unlike a whole unit — their braces may be orphaned
     * across pieces. Surfaced as `metadata.oversplit` for downstream awareness.
     */
    readonly oversplit?: boolean;
}

export class CodeChunker implements IChunker {
    private readonly config: CodeChunkerConfig;

    constructor(config: Partial<CodeChunkerConfig> = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    canHandle(filePath: string): boolean {
        return languageOf(filePath) !== null;
    }

    chunk(content: string, filePath: string): RawChunk[] {
        const language = languageOf(filePath);
        if (language === null || content.trim().length === 0) return [];

        const ext = extensionOf(filePath);
        const tags = tagsFromPath(filePath);
        const lines = content.split('\n');

        const units =
            language === 'brace'
                ? findBraceUnits(lines, maskBraceCode(lines))
                : findPythonUnits(lines);

        const packed = this.packUnits(units)
            .map((u) => ({ content: u.lines.join('\n').trim(), oversplit: u.oversplit }))
            .filter((u) => u.content.length > 0);

        return packed.map((u, i) => ({
            filePath,
            content: u.content,
            fileType: ext || 'text',
            tags,
            chunkIndex: i,
            totalChunks: packed.length,
            metadata: {
                chunkStrategy: 'code-structure',
                symbols: symbolNames(u.content, language),
                ...(u.oversplit ? { oversplit: true } : {}),
            },
        }));
    }

    /**
     * Greedily pack atomic units into chunks up to `maxChars`. A unit that on
     * its own exceeds `maxChars` is force-split first. A trailing chunk smaller
     * than `minChars` is merged back into the previous one.
     */
    private packUnits(units: Unit[]): Unit[] {
        const { maxChars, minChars } = this.config;
        const hardMaxChars = maxChars * HARD_FACTOR;
        const out: Unit[] = [];
        let current: string[] = [];
        let currentLen = 0;
        let currentStart = 0;

        const flush = (): void => {
            if (current.length > 0) {
                out.push({ lines: current, start: currentStart });
                current = [];
                currentLen = 0;
            }
        };

        for (const unit of units) {
            const unitLen = unit.lines.join('\n').length;

            if (unitLen > hardMaxChars) {
                flush();
                for (const piece of forceSplit(unit.lines, maxChars)) {
                    out.push({ lines: piece, start: unit.start, oversplit: true });
                }
                continue;
            }

            if (currentLen > 0 && currentLen + unitLen > maxChars) flush();
            if (current.length === 0) currentStart = unit.start;
            current.push(...unit.lines);
            currentLen += unitLen;
        }
        flush();

        // Merge an undersized trailing chunk back into its predecessor. The
        // merged span inherits `oversplit` if either side carried it — a tiny
        // tail of a force-split container (e.g. a lone closing brace) must not
        // launder the flag off, or it would read as a clean whole unit.
        if (out.length >= 2) {
            const last = out[out.length - 1];
            if (last.lines.join('\n').trim().length < minChars) {
                const prev = out[out.length - 2];
                out[out.length - 2] = {
                    lines: [...prev.lines, ...last.lines],
                    start: prev.start,
                    oversplit: prev.oversplit || last.oversplit,
                };
                out.pop();
            }
        }
        return out;
    }
}

// =============================================================================
// Language detection
// =============================================================================

function extensionOf(filePath: string): string {
    return filePath.split('.').pop()?.toLowerCase() ?? '';
}

function languageOf(filePath: string): Language | null {
    const ext = extensionOf(filePath);
    if (BRACE_EXTENSIONS.has(ext)) return 'brace';
    if (PYTHON_EXTENSIONS.has(ext)) return 'python';
    return null;
}

function tagsFromPath(filePath: string): string[] {
    return filePath
        .split('/')
        .slice(0, -1)
        .filter((p) => p.length > 0 && p !== '.' && !p.startsWith('_'));
}

// =============================================================================
// Masking — replace string/comment spans with spaces (length-preserving)
// =============================================================================

/**
 * Masking is a tiny state machine over each line. `span` names the multi-line
 * region we are currently inside (carried across lines); `delim` holds the
 * exact closing token (quote char or triple-quote). Each step either consumes
 * one closing region or scans code for the next region opener — split into two
 * small helpers per language to keep each branch shallow.
 */
type Span = 'block' | 'template' | 'string' | 'triple' | null;

interface MaskState {
    span: Span;
    delim: string;
}

/** Inside a brace-language span: emit spaces, detect the close. Returns next index. */
function consumeBraceSpan(line: string, i: number, state: MaskState, out: string[]): number {
    const c = line[i];
    if (state.span === 'block') {
        if (c === '*' && line[i + 1] === '/') {
            state.span = null;
            out.push('  ');
            return i + 2;
        }
        out.push(' ');
        return i + 1;
    }
    // 'template' or 'string' — both close on `delim` when not escaped.
    out.push(' ');
    if (c === state.delim && line[i - 1] !== '\\') state.span = null;
    return i + 1;
}

/** In brace-language code: emit the char, or open a comment/string/template span. */
function consumeBraceCode(line: string, i: number, state: MaskState, out: string[]): number {
    const c = line[i];
    const next = line[i + 1];
    if (c === '/' && next === '/') {
        out.push(' '.repeat(line.length - i));
        return line.length;
    }
    if (c === '/' && next === '*') {
        state.span = 'block';
        out.push('  ');
        return i + 2;
    }
    if (c === '"' || c === "'") {
        state.span = 'string';
        state.delim = c;
        out.push(' ');
        return i + 1;
    }
    if (c === '`') {
        state.span = 'template';
        state.delim = '`';
        out.push(' ');
        return i + 1;
    }
    out.push(c);
    return i + 1;
}

function maskBraceLine(line: string, state: MaskState): string {
    const out: string[] = [];
    let i = 0;
    while (i < line.length) {
        i = state.span ? consumeBraceSpan(line, i, state, out) : consumeBraceCode(line, i, state, out);
    }
    // A single/double-quoted string cannot span lines (only template literals
    // and block comments do). If one is still "open" at end of line it was a
    // false positive — a quote inside a regex literal, e.g. /^['"]$/ — so reset
    // it to stop the masked span bleeding into following lines.
    if (state.span === 'string') state.span = null;
    return out.join('');
}

/**
 * Mask string/comment spans across a block of brace-language lines. Exported
 * for structural eval/assertion use — counting braces on the masked output is
 * the only reliable way to verify a chunk is brace-balanced (a regex strip
 * cannot, which is why this stateful masker exists).
 */
export function maskBraceCode(lines: string[]): string[] {
    const state: MaskState = { span: null, delim: '' };
    return lines.map((line) => maskBraceLine(line, state));
}

/** Inside a Python span: emit spaces, detect the close. Returns next index. */
function consumePythonSpan(line: string, i: number, state: MaskState, out: string[]): number {
    if (state.span === 'triple') {
        if (line.slice(i, i + 3) === state.delim) {
            state.span = null;
            out.push('   ');
            return i + 3;
        }
        out.push(' ');
        return i + 1;
    }
    // single-quoted string
    out.push(' ');
    if (line[i] === state.delim && line[i - 1] !== '\\') state.span = null;
    return i + 1;
}

/** In Python code: emit the char, or open a triple/string span or `#` comment. */
function consumePythonCode(line: string, i: number, state: MaskState, out: string[]): number {
    const c = line[i];
    const triple = line.slice(i, i + 3);
    if (triple === "'''" || triple === '"""') {
        state.span = 'triple';
        state.delim = triple;
        out.push('   ');
        return i + 3;
    }
    if (c === '#') {
        out.push(' '.repeat(line.length - i));
        return line.length;
    }
    if (c === '"' || c === "'") {
        state.span = 'string';
        state.delim = c;
        out.push(' ');
        return i + 1;
    }
    out.push(c);
    return i + 1;
}

function maskPythonLine(line: string, state: MaskState): string {
    const out: string[] = [];
    let i = 0;
    while (i < line.length) {
        i = state.span ? consumePythonSpan(line, i, state, out) : consumePythonCode(line, i, state, out);
    }
    return out.join('');
}

// =============================================================================
// Unit discovery — split into atomic top-level spans
// =============================================================================

/** Net brace delta of a masked line. */
function braceDelta(maskedLine: string): number {
    let delta = 0;
    for (const c of maskedLine) {
        if (c === '{') delta++;
        else if (c === '}') delta--;
    }
    return delta;
}

/**
 * Brace languages: a new unit may start on any line where nesting depth is 0
 * (and the line is not a pure continuation). Each unit is therefore a complete,
 * brace-balanced top-level construct plus the blank lines that follow it.
 */
function findBraceUnits(lines: string[], masked: string[]): Unit[] {
    const boundaries: number[] = [];
    let depth = 0;
    for (let i = 0; i < lines.length; i++) {
        if (depth <= 0) boundaries.push(i);
        depth = Math.max(0, depth + braceDelta(masked[i]));
    }
    return slice(lines, dedupeSorted(boundaries));
}

/**
 * Python: a new unit may start on any line that begins in column 0 (a top-level
 * statement, def, or class) and is not the continuation of a triple-quoted
 * string. Indented bodies stay attached to their owner.
 */
function findPythonUnits(lines: string[]): Unit[] {
    const boundaries: number[] = [0];
    const state: MaskState = { span: null, delim: '' };
    for (let i = 0; i < lines.length; i++) {
        const wasInTriple = state.span === 'triple';
        maskPythonLine(lines[i], state); // advance triple-quote tracking
        if (i === 0) continue;
        const startsColumnZero = /^\S/.test(lines[i]);
        if (startsColumnZero && !wasInTriple) boundaries.push(i);
    }
    return slice(lines, dedupeSorted(boundaries));
}

function dedupeSorted(xs: number[]): number[] {
    const out: number[] = [];
    for (const x of xs) {
        if (out.length === 0 || out[out.length - 1] !== x) out.push(x);
    }
    return out;
}

/** Cut `lines` at the given start indices into atomic units. */
function slice(lines: string[], starts: number[]): Unit[] {
    const units: Unit[] = [];
    for (let b = 0; b < starts.length; b++) {
        const from = starts[b];
        const to = b + 1 < starts.length ? starts[b + 1] : lines.length;
        if (to > from) units.push({ lines: lines.slice(from, to), start: from });
    }
    return units;
}

// =============================================================================
// Force-split — last resort for a single oversized unit (never drops lines)
// =============================================================================

function splitParagraphs(lines: string[]): string[][] {
    const paragraphs: string[][] = [];
    let buf: string[] = [];
    for (const line of lines) {
        if (line.trim().length === 0 && buf.length > 0) {
            paragraphs.push(buf);
            buf = [];
        } else {
            buf.push(line);
        }
    }
    if (buf.length > 0) paragraphs.push(buf);
    return paragraphs;
}

function forceSplit(lines: string[], maxChars: number): string[][] {
    // First try blank-line paragraphs; a paragraph still over budget falls back
    // to fixed line windows. Either way, no line is dropped.
    const out: string[][] = [];
    let current: string[] = [];
    let len = 0;
    const flush = (): void => {
        if (current.length > 0) {
            out.push(current);
            current = [];
            len = 0;
        }
    };

    for (const para of splitParagraphs(lines)) {
        const paraLen = para.join('\n').length;
        if (paraLen > maxChars) {
            flush();
            out.push(...lineWindows(para, maxChars));
            continue;
        }
        if (len > 0 && len + paraLen > maxChars) flush();
        current.push(...para);
        len += paraLen;
    }
    flush();
    return out.length > 0 ? out : [lines];
}

/** Fixed-size windows by character budget — the final safety net. */
function lineWindows(lines: string[], maxChars: number): string[][] {
    const out: string[][] = [];
    let current: string[] = [];
    let len = 0;
    for (const line of lines) {
        if (len > 0 && len + line.length + 1 > maxChars) {
            out.push(current);
            current = [];
            len = 0;
        }
        current.push(line);
        len += line.length + 1;
    }
    if (current.length > 0) out.push(current);
    return out;
}

// =============================================================================
// Symbol-name extraction (metadata only — best effort)
// =============================================================================

const BRACE_SYMBOL =
    /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|interface|type|enum)\s+([A-Za-z0-9_$]+)/;
const PYTHON_SYMBOL = /^(?:async\s+)?(?:def|class)\s+([A-Za-z0-9_]+)/;

function symbolNames(content: string, language: Language): string[] {
    const re = language === 'brace' ? BRACE_SYMBOL : PYTHON_SYMBOL;
    const names = new Set<string>();
    for (const line of content.split('\n')) {
        const m = re.exec(line);
        if (m) names.add(m[1]);
    }
    return [...names];
}
