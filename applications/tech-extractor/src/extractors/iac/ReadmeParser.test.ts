/** @format */
import { describe, it, expect } from '@jest/globals';
import { parseReadme } from './ReadmeParser.js';

describe('parseReadme', () => {
    it('extracts shields.io badge subjects as readme-layer tokens', () => {
        const md = [
            '# My Project',
            '![build](https://img.shields.io/badge/React-18-blue)',
            '[![pg](https://img.shields.io/badge/PostgreSQL-16-blue)](#)',
        ].join('\n');
        const out = parseReadme(md, 'README.md');
        const names = out.map(o => o.raw_name);
        expect(names).toContain('React');
        expect(names).toContain('PostgreSQL');
        expect(out.every(o => o.source_layer === 'readme')).toBe(true);
    });

    it('returns [] when there are no badges', () => {
        expect(parseReadme('# Title\nsome prose', 'README.md')).toEqual([]);
    });
});
