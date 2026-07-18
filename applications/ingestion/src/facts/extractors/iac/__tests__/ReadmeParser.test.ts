/** @format */
import { describe, it, expect } from '@jest/globals';
import { parseReadme, parseReadmeProse, scanProseRanges } from '../ReadmeParser.js';

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

describe('parseReadmeProse', () => {
    const aliases = new Set(['kubernetes', 'grafana', 'prometheus', 'terraform', 'fastapi', '@aws-sdk/client-s3', 'aws_lambda', 'pgvector']);

    it('emits one evidence per (alias x line) for case-insensitive matches', () => {
        const md = [
            '# My Project',
            'We deploy to Kubernetes and use Grafana for dashboards.',
            'Metrics flow through Prometheus.',
        ].join('\n');
        const out = parseReadmeProse(md, 'README.md', aliases);
        const names = out.map((o) => o.raw_name).sort();
        expect(names).toEqual(['grafana', 'kubernetes', 'prometheus']);
        // line tracking
        expect(out.find((o) => o.raw_name === 'kubernetes')?.line_start).toBe(2);
        expect(out.find((o) => o.raw_name === 'prometheus')?.line_start).toBe(3);
        // all readme-layer
        expect(out.every((o) => o.source_layer === 'readme' && o.ecosystem === 'readme')).toBe(true);
    });

    it('dedupes within a line (same alias mentioned twice on one line)', () => {
        const out = parseReadmeProse('grafana grafana grafana', 'README.md', new Set(['grafana']));
        expect(out).toHaveLength(1);
    });

    it('emits multiple evidence rows for the same alias on different lines', () => {
        const md = 'grafana\ngrafana\ngrafana';
        const out = parseReadmeProse(md, 'README.md', new Set(['grafana']));
        expect(out).toHaveLength(3);
        expect(out.map((o) => o.line_start)).toEqual([1, 2, 3]);
    });

    it('respects word-boundary — does not match substrings of larger words', () => {
        const md = 'unkubernetesness rubicon grafanesque';
        const out = parseReadmeProse(md, 'README.md', new Set(['kubernetes', 'grafana']));
        expect(out).toEqual([]);
    });

    it('matches multi-part aliases preserving `-` `_` `/` `@` `.`', () => {
        const md = [
            'Built with @aws-sdk/client-s3 and aws_lambda.',
            'Vector search via pgvector.',
        ].join('\n');
        const out = parseReadmeProse(md, 'README.md', aliases);
        const names = out.map((o) => o.raw_name).sort();
        expect(names).toEqual(['@aws-sdk/client-s3', 'aws_lambda', 'pgvector']);
    });

    it('respects opts.minAliasLength (default 4)', () => {
        // 'go' (2 chars) is in the set but below the floor — skipped.
        const out = parseReadmeProse('we use go and rust', 'README.md', new Set(['go', 'rust']));
        // 'rust' = 4 chars meets default floor
        expect(out.map((o) => o.raw_name)).toEqual(['rust']);
    });

    it('opts.minAliasLength is configurable', () => {
        // Lift the floor to 6 — `rust` (4) drops out, `grafana` (7) stays.
        const out = parseReadmeProse('rust and grafana', 'README.md', new Set(['rust', 'grafana']), { minAliasLength: 6 });
        expect(out.map((o) => o.raw_name)).toEqual(['grafana']);
    });

    it('respects opts.maxEmissions (default 200)', () => {
        const md = Array.from({ length: 300 }, (_, i) => `line ${i} grafana`).join('\n');
        const out = parseReadmeProse(md, 'README.md', new Set(['grafana']), { maxEmissions: 50 });
        expect(out).toHaveLength(50);
    });

    it('returns [] for an empty alias set', () => {
        expect(parseReadmeProse('lots of text mentioning grafana', 'README.md', new Set())).toEqual([]);
    });

    it('returns [] for empty src', () => {
        expect(parseReadmeProse('', 'README.md', aliases)).toEqual([]);
    });

    it('does not match aliases the prose-safe tagger correctly rejected (caller filtered)', () => {
        // 'go', 'react', 'next' are NOT in the alias set because the tagger
        // marked them prose_safe=false; the caller filters before passing in.
        // So this prose does NOT match them even though they appear.
        const md = 'We had to go through several iterations. React to changes quickly. Next we will ...';
        const out = parseReadmeProse(md, 'README.md', aliases); // aliases set has no go/react/next
        expect(out).toEqual([]);
    });
});

describe('scanProseRanges', () => {
    it('emits evidence at the input range line_start values', () => {
        const ranges = [
            { text: 'we deploy to kubernetes', line_start: 42 },
            { text: 'using grafana for dashboards', line_start: 99 },
        ];
        const out = scanProseRanges(ranges, 'src/x.ts', new Set(['kubernetes', 'grafana']));
        expect(out).toEqual([
            { raw_name: 'kubernetes', ecosystem: 'readme', source_layer: 'readme', file_path: 'src/x.ts', line_start: 42, line_end: 42 },
            { raw_name: 'grafana',    ecosystem: 'readme', source_layer: 'readme', file_path: 'src/x.ts', line_start: 99, line_end: 99 },
        ]);
    });

    it('dedupes alias mentions within a single range', () => {
        const ranges = [{ text: 'grafana grafana grafana', line_start: 5 }];
        const out = scanProseRanges(ranges, 'x.ts', new Set(['grafana']));
        expect(out).toHaveLength(1);
        expect(out[0].line_start).toBe(5);
    });
});

describe('scanProseRanges — F4 bigram with prefix guard', () => {
    const aliases = new Set(['aws_bedrock', 'amazon_cognito', 'azure_sql', 'aws_step_functions', 'aws_iam', 'grafana']);

    it('matches "aws bedrock" -> aws_bedrock via aws-prefix bigram', () => {
        const out = scanProseRanges([{ text: 'we use aws bedrock for inference', line_start: 1 }], 'x.md', aliases);
        expect(out.map((o) => o.raw_name)).toContain('aws_bedrock');
    });

    it('matches "Amazon Cognito" -> amazon_cognito (case-insensitive)', () => {
        const out = scanProseRanges([{ text: 'Auth via Amazon Cognito', line_start: 1 }], 'x.md', aliases);
        expect(out.map((o) => o.raw_name)).toContain('amazon_cognito');
    });

    it('matches "Azure SQL" -> azure_sql', () => {
        const out = scanProseRanges([{ text: 'Backed by Azure SQL', line_start: 1 }], 'x.md', aliases);
        expect(out.map((o) => o.raw_name)).toContain('azure_sql');
    });

    it('does NOT bigram non-prefix tokens — "step functions" alone does not match aws_step_functions', () => {
        const out = scanProseRanges([{ text: 'we use step functions for orchestration', line_start: 1 }], 'x.md', aliases);
        expect(out.map((o) => o.raw_name)).not.toContain('aws_step_functions');
    });

    it('bigrams "aws step" but it has no alias — silently dropped', () => {
        const out = scanProseRanges([{ text: 'aws step pipeline', line_start: 1 }], 'x.md', aliases);
        expect(out).toEqual([]);
    });

    it('still emits single-token matches alongside bigrams', () => {
        const out = scanProseRanges([{ text: 'grafana dashboards backed by aws bedrock', line_start: 1 }], 'x.md', aliases);
        const names = out.map((o) => o.raw_name).sort();
        expect(names).toEqual(['aws_bedrock', 'grafana']);
    });
});

describe('scanProseRanges — F4 negation detection', () => {
    const aliases = new Set(['grafana', 'cognito', 'redis', 'aws_bedrock']);

    it('suppresses matches on lines containing "not using"', () => {
        const out = scanProseRanges([{ text: 'We are not using grafana for this project', line_start: 1 }], 'x.md', aliases);
        expect(out).toEqual([]);
    });

    it('suppresses matches on lines containing "instead of"', () => {
        const out = scanProseRanges([{ text: 'We chose datadog instead of grafana', line_start: 1 }], 'x.md', aliases);
        expect(out).toEqual([]);
    });

    it('suppresses matches on lines containing "considered but"', () => {
        const out = scanProseRanges([{ text: 'We considered but rejected cognito', line_start: 1 }], 'x.md', aliases);
        expect(out).toEqual([]);
    });

    it('suppresses matches on lines containing "migrated from"', () => {
        const out = scanProseRanges([{ text: 'Migrated from redis to dynamodb last year', line_start: 1 }], 'x.md', aliases);
        expect(out).toEqual([]);
    });

    it('does NOT suppress matches on lines with positive mentions even if other lines have negation', () => {
        const ranges = [
            { text: 'we are not using grafana for dashboards', line_start: 1 },
            { text: 'we use grafana for alerting',             line_start: 2 },
        ];
        const out = scanProseRanges(ranges, 'x.md', aliases);
        expect(out.map((o) => o.line_start)).toEqual([2]);
    });

    it('negation also suppresses bigram matches', () => {
        const out = scanProseRanges([{ text: 'not using aws bedrock for inference', line_start: 1 }], 'x.md', aliases);
        expect(out).toEqual([]);
    });
});
