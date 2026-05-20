/**
 * @format
 * ChunkerRegistry Unit Tests
 *
 * Pure logic — no mocks, no async, no AWS calls.
 * Validates routing correctness and catch-all ordering.
 */

import { ChunkerRegistry } from './ChunkerRegistry';
import { DefaultChunker } from './DefaultChunker';
import type { IChunker } from '../interfaces/IChunker';
import type { RawChunk } from '../../rds/types';

// =============================================================================
// Test double — a named chunker that only handles a specific extension
// =============================================================================

class StubChunker implements IChunker {
    readonly name: string;
    readonly extension: string;
    private callCount = 0;

    constructor(name: string, extension: string) {
        this.name      = name;
        this.extension = extension;
    }

    canHandle(filePath: string): boolean {
        return filePath.endsWith(this.extension);
    }

    chunk(_content: string, filePath: string): RawChunk[] {
        this.callCount++;
        // Always return the identity marker — tests assert on which chunker
        // was selected, not on content transformation.
        return [{
            filePath,
            content:     `stub:${this.name}`,
            fileType:    this.extension.replace('.', ''),
            tags:        [],
            chunkIndex:  0,
            totalChunks: 1,
        }];
    }

    getCalls(): number {
        return this.callCount;
    }
}

// =============================================================================
// Tests
// =============================================================================

describe('ChunkerRegistry', () => {

    // =========================================================================
    // Constructor validation
    // =========================================================================
    describe('constructor', () => {
        it('throws when constructed with an empty chunker list', () => {
            expect(() => new ChunkerRegistry([])).toThrow(
                'at least one chunker is required',
            );
        });

        it('accepts a single chunker', () => {
            expect(() => new ChunkerRegistry([new DefaultChunker()])).not.toThrow();
        });
    });

    // =========================================================================
    // chunk() — routing
    // =========================================================================
    describe('chunk() — routing', () => {
        const mdChunker      = new StubChunker('md', '.md');
        const tsChunker      = new StubChunker('ts', '.ts');
        // Override canHandle on default to always return true (catch-all)
        const catchAll: IChunker = {
            canHandle: (_: string) => true,
            chunk: (content: string, filePath: string) => [{
                filePath,
                content:     'default-chunk',
                fileType:    'text',
                tags:        [],
                chunkIndex:  0,
                totalChunks: 1,
            }],
        };

        const registry = new ChunkerRegistry([mdChunker, tsChunker, catchAll]);

        it('routes .md files to the markdown chunker', () => {
            const chunks = registry.chunk('# Hello\n\nContent here.', 'README.md');
            expect(chunks[0].content).toBe('stub:md');
        });

        it('routes .ts files to the TypeScript chunker', () => {
            const chunks = registry.chunk('export const x = 1;', 'src/index.ts');
            expect(chunks[0].content).toBe('stub:ts');
        });

        it('routes unrecognised extensions to the catch-all', () => {
            const chunks = registry.chunk('some content', 'data.csv');
            expect(chunks[0].content).toBe('default-chunk');
        });

        it('routes .json to the catch-all when no json chunker is registered', () => {
            const chunks = registry.chunk('{}', 'package.json');
            expect(chunks[0].content).toBe('default-chunk');
        });
    });

    // =========================================================================
    // chunk() — catch-all ordering
    // =========================================================================
    describe('chunk() — catch-all ordering', () => {
        it('uses the first matching chunker, not the last', () => {
            const first  = new StubChunker('first', '.md');
            const second = new StubChunker('second', '.md');
            const registry = new ChunkerRegistry([first, second]);

            registry.chunk('# Title\n\nContent.', 'README.md');

            expect(first.getCalls()).toBe(1);
            expect(second.getCalls()).toBe(0);
        });

        it('a catch-all registered before a specific chunker swallows it', () => {
            // This test documents the incorrect ordering — catch-all first
            const catchAll: IChunker = {
                canHandle: () => true,
                chunk: (content, filePath) => [{
                    filePath, content: 'catch-all', fileType: 'text',
                    tags: [], chunkIndex: 0, totalChunks: 1,
                }],
            };
            const specific = new StubChunker('md', '.md');

            // Wrong order: catch-all before specific
            const badRegistry = new ChunkerRegistry([catchAll, specific]);
            const chunks = badRegistry.chunk('# Title\n\nContent.', 'README.md');

            // Specific chunker is never reached
            expect(chunks[0].content).toBe('catch-all');
            expect(specific.getCalls()).toBe(0);
        });

        it('correct order: specific chunkers before catch-all', () => {
            const specific = new StubChunker('md', '.md');
            const catchAll: IChunker = {
                canHandle: () => true,
                chunk: (_, filePath) => [{
                    filePath, content: 'catch-all', fileType: 'text',
                    tags: [], chunkIndex: 0, totalChunks: 1,
                }],
            };

            const registry = new ChunkerRegistry([specific, catchAll]);
            const chunks = registry.chunk('# Title\n\nContent.', 'README.md');

            expect(chunks[0].content).toBe('stub:md');
            expect(specific.getCalls()).toBe(1);
        });
    });

    // =========================================================================
    // chunk() — throws when no chunker matches
    // =========================================================================
    describe('chunk() — no match', () => {
        it('throws a descriptive error when no chunker can handle the file', () => {
            const registry = new ChunkerRegistry([new StubChunker('md', '.md')]);

            expect(() => registry.chunk('content', 'image.png')).toThrow(
                /no chunker registered for file: image\.png/,
            );
        });
    });

    // =========================================================================
    // canHandle()
    // =========================================================================
    describe('canHandle()', () => {
        const registry = new ChunkerRegistry([
            new StubChunker('md', '.md'),
            new StubChunker('ts', '.ts'),
        ]);

        it('returns true when at least one chunker matches', () => {
            expect(registry.canHandle('README.md')).toBe(true);
            expect(registry.canHandle('src/index.ts')).toBe(true);
        });

        it('returns false when no chunker matches', () => {
            expect(registry.canHandle('image.png')).toBe(false);
            expect(registry.canHandle('data.csv')).toBe(false);
        });
    });

    // =========================================================================
    // withDefaults() — factory
    // =========================================================================
    describe('withDefaults()', () => {
        const registry = ChunkerRegistry.withDefaults();

        it('handles .md files with MarkdownChunker', () => {
            const chunks = registry.chunk(
                '# Heading\n\nContent that is long enough to pass the minimum character threshold.',
                'docs/overview.md',
            );
            expect(chunks.length).toBeGreaterThan(0);
            expect(chunks[0].fileType).toBe('md');
            expect(chunks[0].heading).toBe('# Heading');
        });

        it('handles .ts files with DefaultChunker', () => {
            const chunks = registry.chunk(
                'export const x = 1;\nexport const y = 2;',
                'src/index.ts',
            );
            expect(chunks.length).toBeGreaterThan(0);
            expect(chunks[0].fileType).toBe('ts');
            // DefaultChunker does not set heading
            expect(chunks[0].heading).toBeUndefined();
        });

        it('handles .json files with DefaultChunker', () => {
            const chunks = registry.chunk('{ "name": "portfolio" }', 'package.json');
            expect(chunks[0].fileType).toBe('json');
        });

        it('handles .mdx files with MarkdownChunker', () => {
            const chunks = registry.chunk(
                '# MDX Component\n\nContent with enough characters to pass the minimum threshold.',
                'pages/index.mdx',
            );
            expect(chunks[0].fileType).toBe('mdx');
        });

        it('produces chunks for every registered file type without throwing', () => {
            const types = ['README.md', 'index.ts', 'config.yaml', 'package.json', 'main.py'];
            for (const filePath of types) {
                expect(() => registry.chunk('content line\nmore content', filePath)).not.toThrow();
            }
        });
    });
});
