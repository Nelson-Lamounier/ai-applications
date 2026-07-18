/** @format */
import { describe, it, expect } from '@jest/globals';
import { parseTerraform } from '../TerraformParser.js';

describe('parseTerraform', () => {
    it('extracts resource declarations + a terraform token', () => {
        const src = [
            'resource "aws_lambda_function" "fn" {}',
            'resource "google_storage_bucket" "b" {}',
        ].join('\n');
        const out = parseTerraform(src, 'main.tf');
        const names = out.map(o => o.raw_name);
        expect(names).toContain('terraform');
        expect(names).toContain('aws_lambda_function');
        expect(names).toContain('google_storage_bucket');
        expect(out.every(o => o.source_layer === 'iac')).toBe(true);
    });

    it('returns [] when there are no resource blocks', () => {
        expect(parseTerraform('variable "x" {}', 'vars.tf')).toEqual([]);
    });
});
