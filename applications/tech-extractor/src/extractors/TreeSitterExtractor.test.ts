/** @format */
import { describe, it, expect } from '@jest/globals';
import { extractImportsByRegex, matchSdkCalls } from './TreeSitterExtractor.js';

describe('extractImportsByRegex', () => {
    it('pulls module names from python and js/ts imports', () => {
        const py = 'import os\nfrom django.db import models';
        expect(extractImportsByRegex(py, 'python', 'a.py').map(e => e.raw_name)).toEqual(['os','django']);

        const ts = "import express from 'express';\nimport { z } from 'zod';";
        expect(extractImportsByRegex(ts, 'typescript', 'a.ts').map(e => e.raw_name)).toEqual(['express','zod']);
    });
});

describe('matchSdkCalls', () => {
    it('flags known SDK call patterns', () => {
        const py = "import boto3\ns3 = boto3.client('s3')";
        const out = matchSdkCalls(py, 'python', 'a.py');
        expect(out.map(e => e.raw_name)).toContain('aws');
        expect(out.every(e => e.source_layer === 'treesitter')).toBe(true);
    });
    it('returns [] when no pattern matches', () => {
        expect(matchSdkCalls('print(1)', 'python', 'a.py')).toEqual([]);
    });
});
