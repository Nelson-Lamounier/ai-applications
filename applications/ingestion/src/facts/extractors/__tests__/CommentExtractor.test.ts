/** @format */
import { describe, it, expect } from '@jest/globals';
import { extractProseRanges } from '../CommentExtractor.js';

describe('extractProseRanges — TypeScript/JavaScript', () => {
    it('captures a single-line // comment', () => {
        const src = 'const x = 1;\n// Use Cognito for auth\nconst y = 2;';
        const ranges = extractProseRanges(src, 'typescript');
        const matches = ranges.filter((r) => r.text.includes('Use Cognito for auth'));
        expect(matches).toHaveLength(1);
        expect(matches[0].line_start).toBe(2);
        expect(matches[0].line_end).toBe(2);
    });

    it('captures a multi-line /** */ block comment', () => {
        const src = '/** \n * Wraps AWS Cognito\n * for testing.\n */\nconst z = 3;';
        const ranges = extractProseRanges(src, 'typescript');
        const blocks = ranges.filter((r) => r.text.includes('Cognito') && r.line_start === 1);
        expect(blocks).toHaveLength(1);
        expect(blocks[0].line_start).toBe(1);
        expect(blocks[0].line_end).toBe(4);
    });

    it('captures string literals containing prose', () => {
        const src = 'const label = "Secured by AWS Cognito · SOC 2 Type II";';
        const ranges = extractProseRanges(src, 'typescript');
        expect(ranges.some((r) => r.text.includes('Cognito'))).toBe(true);
    });

    it('excludes import source strings but keeps other string literals', () => {
        const src = "import {x} from '@aws-sdk/client-s3';\nconst note = \"Uses s3 client\";";
        const ranges = extractProseRanges(src, 'typescript');
        const concat = ranges.map((r) => r.text).join('|');
        expect(concat).toContain('Uses s3 client');
        expect(concat).not.toContain('@aws-sdk');
    });

    it('excludes require() argument strings', () => {
        const src = 'const fs = require("node:fs");';
        const ranges = extractProseRanges(src, 'javascript');
        expect(ranges.some((r) => r.text.includes('node:fs'))).toBe(false);
    });
});

describe('extractProseRanges — Python', () => {
    it('captures # line comments', () => {
        const src = '# Uses cognito\nx = 1';
        const ranges = extractProseRanges(src, 'python');
        const matches = ranges.filter((r) => r.text.includes('Uses cognito'));
        expect(matches).toHaveLength(1);
    });

    it('captures triple-quoted docstrings as one multi-line range', () => {
        const src = 'def f():\n    """\n    Wraps grafana\n    """\n    pass';
        const ranges = extractProseRanges(src, 'python');
        const docs = ranges.filter((r) => r.text.includes('grafana'));
        expect(docs).toHaveLength(1);
        expect(docs[0].line_start).toBe(2);
        expect(docs[0].line_end).toBe(4);
    });

    it('captures non-import string literals but excludes import lines', () => {
        const src = 'import boto3\nfrom typing import Optional\nx = "boto3 helper"';
        const ranges = extractProseRanges(src, 'python');
        const texts = ranges.map((r) => r.text);
        expect(texts).toContain('boto3 helper');
        expect(texts.every((t) => t.trim() !== 'boto3')).toBe(true);
    });
});

describe('extractProseRanges — Go', () => {
    it('captures // line comments and /* */ block comments', () => {
        const src = '// Package main uses prometheus\npackage main\n/* Wraps grafana */';
        const ranges = extractProseRanges(src, 'go');
        const trimmed = ranges.map((r) => r.text.trim());
        expect(trimmed).toContain('Package main uses prometheus');
        expect(trimmed).toContain('Wraps grafana');
    });
});

describe('extractProseRanges — YAML', () => {
    it('extracts # comment lines at start of line', () => {
        const src = [
            'key: value',
            '# Uses kubernetes for orchestration',
            'list:',
            '  - { name: a }',
            '  # Wraps grafana for dashboards',
            '  - { name: b }',
        ].join('\n');
        const ranges = extractProseRanges(src, 'yaml');
        const trimmed = ranges.map((r) => r.text.trim());
        expect(trimmed).toContain('Uses kubernetes for orchestration');
        expect(trimmed).toContain('Wraps grafana for dashboards');
        expect(ranges.find((r) => r.text.includes('kubernetes'))?.line_start).toBe(2);
        expect(ranges.find((r) => r.text.includes('grafana'))?.line_start).toBe(5);
    });

    it('returns [] when no comment lines', () => {
        const src = 'apiVersion: v1\nkind: ConfigMap\ndata: { x: y }';
        expect(extractProseRanges(src, 'yaml')).toEqual([]);
    });

    it('skips lines where # appears mid-line (does not over-match values containing #)', () => {
        const src = 'key: "value with # in it"\nother: foo';
        expect(extractProseRanges(src, 'yaml')).toEqual([]);
    });
});

describe('extractProseRanges — unsupported lang', () => {
    it('returns [] for unsupported languages', () => {
        expect(extractProseRanges('// hi', 'rust' as never)).toEqual([]);
    });
});
