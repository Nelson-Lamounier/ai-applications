/** @format */
import { describe, it, expect } from '@jest/globals';
import { parseGithubActions } from '../GithubActionsParser.js';

describe('parseGithubActions', () => {
    it('emits github_actions + each used action name', () => {
        const yaml = [
            'on: push',
            'jobs:',
            '  build:',
            '    steps:',
            '      - uses: actions/checkout@v4',
            '      - uses: aws-actions/configure-aws-credentials@v4',
        ].join('\n');
        const out = parseGithubActions(yaml, '.github/workflows/ci.yaml');
        const names = out.map(o => o.raw_name);
        expect(names).toContain('github_actions');
        expect(names).toContain('actions/checkout');
        expect(names).toContain('aws-actions/configure-aws-credentials');
    });

    it('returns [] when there are no uses: lines', () => {
        expect(parseGithubActions('name: x', '.github/workflows/x.yaml')).toEqual([]);
    });
});
