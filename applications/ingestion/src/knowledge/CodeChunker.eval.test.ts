/**
 * @format
 * CodeChunker Eval — invariants on a real, production-shaped corpus
 *
 * Per the repo's LLM-workflow discipline, a chunking change ships with an eval
 * that defines what "good output" means for the phase. Toy inputs live in
 * CodeChunker.test.ts; this eval runs the chunker over genuine source files
 * (its own implementation plus the legacy DefaultChunker) and asserts the
 * structural guarantees that retrieval quality depends on:
 *
 *   1. No chunk cuts through a symbol  — every chunk is brace-balanced.
 *   2. No source line is lost          — every non-empty line survives.
 *   3. Chunks stay within the size cap — none exceeds the hard ceiling.
 *   4. Real splitting happens          — a 400-line file yields many chunks.
 *   5. Symbols are recoverable         — declared top-level names are detected.
 *
 * Run on every change to the chunker. A regression here means retrieved code is
 * once again arriving as half-symbols.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CodeChunker, maskBraceCode } from './CodeChunker';

/**
 * Net brace balance using the chunker's own string/comment masker — the only
 * reliable counter (a regex strip miscounts apostrophes in comments, braces in
 * regex literals, etc.). Counting `{`/`}` on the masked output verifies a chunk
 * is brace-balanced against the exact depth model the splitter uses.
 */
function braceBalance(content: string): number {
    let depth = 0;
    for (const masked of maskBraceCode(content.split('\n'))) {
        for (const c of masked) {
            if (c === '{') depth++;
            else if (c === '}') depth--;
        }
    }
    return depth;
}

const CORPUS = ['CodeChunker.ts', 'DefaultChunker.ts', 'MarkdownChunker.ts'];
// Default cap (2400) * HARD_FACTOR (4). A chunk may exceed the soft target when
// a single symbol is large, but never the hard ceiling.
const HARD_CEILING = 2400 * 4;

describe('CodeChunker eval — real source corpus', () => {
    const chunker = new CodeChunker();

    for (const fileName of CORPUS) {
        describe(fileName, () => {
            const source = readFileSync(join(__dirname, fileName), 'utf8');
            const chunks = chunker.chunk(source, `src/ingestion/implementations/${fileName}`);

            it('splits a large file into multiple chunks', () => {
                expect(chunks.length).toBeGreaterThan(1);
            });

            it('keeps every whole-unit chunk brace-balanced (never cuts a symbol)', () => {
                // Pieces of an oversized container (metadata.oversplit) legitimately
                // orphan the container's braces; whole units must not.
                for (const c of chunks) {
                    if (c.metadata?.oversplit) continue;
                    expect(braceBalance(c.content)).toBe(0);
                }
            });

            it('invents or drops no braces overall (orphans net to zero)', () => {
                const net = chunks.reduce((sum, c) => sum + braceBalance(c.content), 0);
                expect(net).toBe(0);
            });

            it('keeps every chunk within the hard size ceiling', () => {
                for (const c of chunks) {
                    expect(c.content.length).toBeLessThanOrEqual(HARD_CEILING);
                }
            });

            it('loses no non-empty source line', () => {
                const joined = chunks.map((c) => c.content).join('\n');
                for (const line of source.split('\n')) {
                    const t = line.trim();
                    if (t.length > 0) expect(joined).toContain(t);
                }
            });

            it('tags every chunk with the code-structure strategy', () => {
                for (const c of chunks) {
                    expect(c.metadata?.chunkStrategy).toBe('code-structure');
                }
            });
        });
    }

    it('recovers known top-level symbols from its own source', () => {
        const source = readFileSync(join(__dirname, 'CodeChunker.ts'), 'utf8');
        const chunks = chunker.chunk(source, 'src/ingestion/implementations/CodeChunker.ts');
        const symbols = new Set(chunks.flatMap((c) => (c.metadata?.symbols as string[]) ?? []));
        // Exported and internal declarations the parser must not miss.
        for (const name of ['CodeChunker', 'forceSplit', 'maskBraceLine', 'findBraceUnits']) {
            expect(symbols.has(name)).toBe(true);
        }
    });
});
