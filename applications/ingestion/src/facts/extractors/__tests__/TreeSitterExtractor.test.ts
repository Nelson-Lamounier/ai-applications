/** @format */
import { describe, it, expect } from '@jest/globals';
import { extractImportsByRegex, matchSdkCalls, awsModuleTokens, TreeSitterExtractor } from '../TreeSitterExtractor.js';

describe('extractImportsByRegex', () => {
    it('pulls module names from python and js/ts imports', () => {
        const py = 'import os\nfrom django.db import models';
        expect(extractImportsByRegex(py, 'python', 'a.py').map(e => e.raw_name)).toEqual(['os','django']);

        const ts = "import express from 'express';\nimport { z } from 'zod';";
        expect(extractImportsByRegex(ts, 'typescript', 'a.ts').map(e => e.raw_name)).toEqual(['express','zod']);
    });

    it('emits both the package token AND the aws service token for aws-cdk-lib submodule imports', () => {
        const ts = "import * as lambda from 'aws-cdk-lib/aws-lambda';";
        const out = extractImportsByRegex(ts, 'typescript', 'stack.ts');
        const names = out.map(e => e.raw_name);
        // Package-level token (truncated to first segment for scoped-like path)
        expect(names).toContain('aws-cdk-lib');
        // AWS service token
        expect(names).toContain('lambda');
        expect(out.every(e => e.source_layer === 'treesitter')).toBe(true);
    });

    it('emits both the package token AND the aws service token for @aws-sdk/client-* imports', () => {
        const ts = "import { S3Client } from '@aws-sdk/client-s3';";
        const out = extractImportsByRegex(ts, 'typescript', 'upload.ts');
        const names = out.map(e => e.raw_name);
        expect(names).toContain('@aws-sdk/client-s3');
        expect(names).toContain('s3');
    });

    it('emits multi-word sdk slug as-is for secrets-manager', () => {
        const ts = "import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';";
        const out = extractImportsByRegex(ts, 'typescript', 'secrets.ts');
        const names = out.map(e => e.raw_name);
        expect(names).toContain('secrets-manager');
    });

    it('does not emit extra tokens for non-aws imports', () => {
        const ts = "import { something } from 'lodash';";
        const out = extractImportsByRegex(ts, 'typescript', 'util.ts');
        expect(out).toHaveLength(1);
        expect(out[0].raw_name).toBe('lodash');
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

describe('awsModuleTokens', () => {
    it('extracts service name from aws-cdk-lib submodule', () => {
        expect(awsModuleTokens('aws-cdk-lib/aws-lambda')).toEqual(['lambda']);
        expect(awsModuleTokens('aws-cdk-lib/aws-s3')).toEqual(['s3']);
        expect(awsModuleTokens('aws-cdk-lib/aws-dynamodb')).toEqual(['dynamodb']);
    });

    it('extracts service name from @aws-sdk/client-* module', () => {
        expect(awsModuleTokens('@aws-sdk/client-s3')).toEqual(['s3']);
        expect(awsModuleTokens('@aws-sdk/client-sqs')).toEqual(['sqs']);
    });

    it('preserves hyphenated multi-word sdk slugs', () => {
        expect(awsModuleTokens('@aws-sdk/client-secrets-manager')).toEqual(['secrets-manager']);
        expect(awsModuleTokens('@aws-sdk/client-api-gateway')).toEqual(['api-gateway']);
    });

    it('returns [] for non-matching module strings', () => {
        expect(awsModuleTokens('aws-cdk-lib')).toEqual([]);
        expect(awsModuleTokens('@aws-sdk/util-utf8')).toEqual([]);
        expect(awsModuleTokens('lodash')).toEqual([]);
        expect(awsModuleTokens('express')).toEqual([]);
    });
});

describe('TreeSitterExtractor code-prose wiring', () => {
    it('emits code-prose evidence for prose_safe aliases in comments + string literals', async () => {
        const src = [
            '// uses kubernetes for orchestration',
            'import { x } from "@aws-sdk/client-s3";',
            'const note = "Secured by Grafana dashboards";',
        ].join('\n');
        const ex = new TreeSitterExtractor(
            async () => src,
            ['src/x.ts'],
            new Set(['kubernetes', 'grafana']),
        );
        const out = await ex.extract('/tmp');
        const prose = out.filter(e => e.source_layer === 'code-prose');
        expect(prose.map(e => e.raw_name).sort()).toEqual(['grafana', 'kubernetes']);
        expect(prose.some(e => e.raw_name === '@aws-sdk/client-s3')).toBe(false);
    });
});
