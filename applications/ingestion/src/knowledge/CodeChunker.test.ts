/**
 * @format
 * CodeChunker Unit Tests
 *
 * Pure logic — no mocks, no async, no AWS calls.
 *
 * Core invariants under test:
 *   1. Structural integrity — a chunk never cuts through a top-level symbol
 *      (for brace languages every chunk has balanced braces; depth returns
 *      to 0 within the chunk).
 *   2. No data loss — every non-empty source line survives into some chunk,
 *      in order.
 *   3. Boundary fidelity — braces that live inside strings or comments do not
 *      fool the splitter.
 */

import { CodeChunker } from './CodeChunker';

/** Strip strings and line-comments from a single line of code. */
function stripStringsAndComments(line: string): string {
    const noComment = line.replace(/\/\/.*$/, '');
    // Drop quoted spans ('...', "...", `...`) including their contents.
    return noComment.replace(/(['"`])(?:\\.|(?!\1).)*\1?/g, '');
}

/** Net brace balance of a snippet, ignoring strings/line-comments. */
function braceBalance(s: string): number {
    let depth = 0;
    for (const line of s.split('\n')) {
        const code = stripStringsAndComments(line);
        for (const c of code) {
            if (c === '{') depth++;
            else if (c === '}') depth--;
        }
    }
    return depth;
}

/** Every non-empty trimmed source line appears in some chunk. */
function assertNoLineLoss(source: string, chunks: { content: string }[]): void {
    const joined = chunks.map((c) => c.content).join('\n');
    for (const line of source.split('\n')) {
        const t = line.trim();
        if (t.length === 0) continue;
        expect(joined).toContain(t);
    }
}

describe('CodeChunker', () => {
    // =========================================================================
    // canHandle
    // =========================================================================
    describe('canHandle()', () => {
        const chunker = new CodeChunker();

        it('accepts TypeScript / TSX / JS / JSX', () => {
            expect(chunker.canHandle('src/index.ts')).toBe(true);
            expect(chunker.canHandle('src/App.tsx')).toBe(true);
            expect(chunker.canHandle('lib/util.js')).toBe(true);
            expect(chunker.canHandle('lib/util.jsx')).toBe(true);
            expect(chunker.canHandle('lib/util.mts')).toBe(true);
        });

        it('accepts Python', () => {
            expect(chunker.canHandle('scripts/run.py')).toBe(true);
        });

        it('accepts other brace languages (Go, Rust, Java, C#, C++)', () => {
            expect(chunker.canHandle('cmd/main.go')).toBe(true);
            expect(chunker.canHandle('src/lib.rs')).toBe(true);
            expect(chunker.canHandle('Service.java')).toBe(true);
            expect(chunker.canHandle('Program.cs')).toBe(true);
            expect(chunker.canHandle('engine.cpp')).toBe(true);
        });

        it('rejects markdown, yaml, json, and unknown', () => {
            expect(chunker.canHandle('README.md')).toBe(false);
            expect(chunker.canHandle('config.yaml')).toBe(false);
            expect(chunker.canHandle('package.json')).toBe(false);
            expect(chunker.canHandle('Makefile')).toBe(false);
        });
    });

    // =========================================================================
    // Small file — fits one chunk, kept whole
    // =========================================================================
    describe('chunk() — small file', () => {
        const chunker = new CodeChunker();
        const ts = [
            "import { a } from './a';",
            '',
            'export function foo(): number {',
            '  return 1;',
            '}',
            '',
            'export function bar(): number {',
            '  return 2;',
            '}',
            '',
        ].join('\n');

        it('keeps a small file in a single chunk', () => {
            const chunks = chunker.chunk(ts, 'src/foo.ts');
            expect(chunks.length).toBe(1);
            expect(chunks[0].content).toContain('function foo');
            expect(chunks[0].content).toContain('function bar');
        });

        it('sets fileType and tags from the path', () => {
            const chunks = chunker.chunk(ts, 'src/api/foo.ts');
            expect(chunks[0].fileType).toBe('ts');
            expect(chunks[0].tags).toEqual(['src', 'api']);
        });

        it('records detected top-level symbol names in metadata', () => {
            const chunks = chunker.chunk(ts, 'src/foo.ts');
            const symbols = chunks[0].metadata?.symbols as string[] | undefined;
            expect(symbols).toEqual(expect.arrayContaining(['foo', 'bar']));
        });

        it('records a 1-based inclusive source-line range in metadata (citable provenance)', () => {
            const chunks = chunker.chunk(ts, 'src/foo.ts');
            const m = chunks[0].metadata as { lineStart?: number; lineEnd?: number };
            expect(m.lineStart).toBe(1);
            expect(typeof m.lineEnd).toBe('number');
            expect(m.lineEnd!).toBeGreaterThanOrEqual(m.lineStart!);
        });
    });

    // =========================================================================
    // Splitting — never cuts through a function
    // =========================================================================
    describe('chunk() — structural splitting (brace languages)', () => {
        // Two functions, each ~50 chars of body, forced apart by a tiny cap.
        const ts = [
            'export function alpha(): number {',
            '  const x = 1;',
            '  const y = 2;',
            '  return x + y;',
            '}',
            '',
            'export function beta(): number {',
            '  const p = 3;',
            '  const q = 4;',
            '  return p * q;',
            '}',
        ].join('\n');

        it('splits between functions when the size cap is exceeded', () => {
            const chunker = new CodeChunker({ maxChars: 80 });
            const chunks = chunker.chunk(ts, 'src/math.ts');
            expect(chunks.length).toBeGreaterThan(1);
        });

        it('every chunk has balanced braces (never cuts mid-function)', () => {
            const chunker = new CodeChunker({ maxChars: 80 });
            const chunks = chunker.chunk(ts, 'src/math.ts');
            for (const c of chunks) {
                expect(braceBalance(c.content)).toBe(0);
            }
        });

        it('loses no source lines when splitting', () => {
            const chunker = new CodeChunker({ maxChars: 80 });
            const chunks = chunker.chunk(ts, 'src/math.ts');
            assertNoLineLoss(ts, chunks);
        });

        it('numbers chunks 0..n-1 with a consistent totalChunks', () => {
            const chunker = new CodeChunker({ maxChars: 80 });
            const chunks = chunker.chunk(ts, 'src/math.ts');
            chunks.forEach((c, i) => {
                expect(c.chunkIndex).toBe(i);
                expect(c.totalChunks).toBe(chunks.length);
            });
        });
    });

    // =========================================================================
    // Braces inside strings / comments must not fool the splitter
    // =========================================================================
    describe('chunk() — strings and comments', () => {
        const ts = [
            'export function tricky(): string {',
            '  // a closing brace } in a comment',
            '  const s = "a } brace and a { brace in a string";',
            '  const t = `template with ${"nested"} and } char`;',
            '  return s + t;',
            '}',
        ].join('\n');

        it('keeps a function whole despite braces in strings/comments', () => {
            // Default (large) cap: the only thing that could split this function
            // is a string/comment brace being mistaken for a real boundary.
            const chunker = new CodeChunker();
            const chunks = chunker.chunk(ts, 'src/tricky.ts');
            expect(chunks.length).toBe(1);
            expect(chunks[0].content).toContain('function tricky');
            expect(chunks[0].content).toContain('return s + t;');
        });
    });

    // =========================================================================
    // Oversized single symbol — sub-split, still no loss
    // =========================================================================
    describe('chunk() — oversized single symbol', () => {
        it('sub-splits a function larger than the cap without losing lines', () => {
            const body = Array.from({ length: 60 }, (_, i) => `  const v${i} = ${i};`);
            const ts = ['export function huge(): void {', ...body, '}'].join('\n');
            const chunker = new CodeChunker({ maxChars: 200 });
            const chunks = chunker.chunk(ts, 'src/huge.ts');
            expect(chunks.length).toBeGreaterThan(1);
            assertNoLineLoss(ts, chunks);
        });
    });

    // =========================================================================
    // Python — indentation-based boundaries
    // =========================================================================
    describe('chunk() — Python', () => {
        const py = [
            'import os',
            '',
            'def foo():',
            '    return 1',
            '',
            'class Bar:',
            '    def method(self):',
            '        return 2',
        ].join('\n');

        it('splits on top-level def/class and keeps each block whole', () => {
            const chunker = new CodeChunker({ maxChars: 60, minChars: 0 });
            const chunks = chunker.chunk(py, 'scripts/run.py');
            expect(chunks.length).toBeGreaterThan(1);
            const owning = chunks.find((c) => c.content.includes('class Bar'));
            expect(owning).toBeDefined();
            // method body stays with its class
            expect(owning?.content).toContain('return 2');
        });

        it('loses no source lines', () => {
            const chunker = new CodeChunker({ maxChars: 60, minChars: 0 });
            const chunks = chunker.chunk(py, 'scripts/run.py');
            assertNoLineLoss(py, chunks);
        });
    });

    // =========================================================================
    // Empty / whitespace
    // =========================================================================
    describe('chunk() — edge cases', () => {
        const chunker = new CodeChunker();

        it('returns no chunks for empty content', () => {
            expect(chunker.chunk('', 'src/empty.ts')).toEqual([]);
            expect(chunker.chunk('   \n  \n', 'src/empty.ts')).toEqual([]);
        });
    });
});
