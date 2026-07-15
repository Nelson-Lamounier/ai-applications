/** @format */
/**
 * Prompt loader tests — frontmatter parsing, cache-point block splitting,
 * strict template rendering, and fidelity of the real content files the
 * pipeline ships (personas + constraints pages must load and keep their
 * Bedrock cachePoint structure).
 */
import { describe, it, expect } from '@jest/globals';

import {
    loadPrompt,
    loadPersona,
    toSystemBlocks,
    renderTemplate,
} from './prompt-loader.js';

describe('loadPrompt', () => {
    it('loads frontmatter and body for a real content file', () => {
        const prompt = loadPrompt('jd-extractor-persona');
        expect(prompt.meta.id).toBe('jd-extractor-persona');
        expect(prompt.meta.version).toBe('1');
        expect(prompt.meta.cachePoint).toBe('none');
        expect(prompt.body).toContain('extract_jd');
    });

    it('memoises: same object identity on repeat load', () => {
        expect(loadPrompt('jd-extractor-persona')).toBe(loadPrompt('jd-extractor-persona'));
    });

    it('throws on a missing prompt file', () => {
        expect(() => loadPrompt('does-not-exist')).toThrow();
    });

    it('loads every shipped content file with valid frontmatter', () => {
        const names = [
            'strategist/summary',
            'research-persona',
            'jd-extractor-persona',
            'constraints/agent-guide',
            'constraints/gap-awareness',
            'constraints/voice-library',
            'constraints/role-archetypes',
            'constraints/achievements',
        ];
        for (const name of names) {
            const prompt = loadPrompt(name);
            expect(prompt.meta.id.length).toBeGreaterThan(0);
            expect(prompt.body.length).toBeGreaterThan(100);
        }
    });
});

describe('toSystemBlocks', () => {
    it('appends a trailing cachePoint when frontmatter says default', () => {
        const blocks = toSystemBlocks({
            meta: { id: 'x', version: '1', cachePoint: 'default' },
            body: 'hello',
        });
        expect(blocks).toEqual([
            { text: 'hello' },
            { cachePoint: { type: 'default' } },
        ]);
    });

    it('emits a single text block when cachePoint is none', () => {
        const blocks = toSystemBlocks({
            meta: { id: 'x', version: '1', cachePoint: 'none' },
            body: 'hello',
        });
        expect(blocks).toEqual([{ text: 'hello' }]);
    });

    it('splits the body on <!-- cache-point --> markers', () => {
        const blocks = toSystemBlocks({
            meta: { id: 'x', version: '1', cachePoint: 'none' },
            body: 'part one\n<!-- cache-point -->\npart two',
        });
        expect(blocks).toEqual([
            { text: 'part one' },
            { cachePoint: { type: 'default' } },
            { text: 'part two' },
        ]);
    });

    it('personas keep the single-text-block + cachePoint shape Bedrock caching relies on', () => {
        for (const name of ['strategist/summary', 'research-persona']) {
            const { blocks } = loadPersona(name);
            expect(blocks).toHaveLength(2);
            expect(blocks[0]).toHaveProperty('text');
            expect(blocks[1]).toEqual({ cachePoint: { type: 'default' } });
        }
    });
});

describe('renderTemplate', () => {
    it('replaces {{name}} placeholders', () => {
        expect(renderTemplate('Hi {{who}}, meet {{who}} again', { who: 'there' }))
            .toBe('Hi there, meet there again');
    });

    it('throws on a placeholder with no value', () => {
        expect(() => renderTemplate('Hi {{missing}}', {})).toThrow(/no value/);
    });

    it('throws on an unused var (typo guard)', () => {
        expect(() => renderTemplate('no placeholders', { typoKey: 'x' })).toThrow(/unused vars/);
    });
});
