/** @format */
import { describe, it, expect } from '@jest/globals';
import { parseDockerfile } from './DockerfileParser.js';

describe('parseDockerfile', () => {
    it('extracts base images from FROM lines with line numbers', () => {
        const src = [
            '# comment',
            'FROM node:22-alpine AS builder',
            'RUN apk add --no-cache git',
            'FROM nginx:1.27',
        ].join('\n');
        const out = parseDockerfile(src, 'Dockerfile');
        expect(out).toEqual([
            { raw_name: 'node', ecosystem: 'docker', source_layer: 'dockerfile', file_path: 'Dockerfile', line_start: 2, line_end: 2 },
            { raw_name: 'nginx', ecosystem: 'docker', source_layer: 'dockerfile', file_path: 'Dockerfile', line_start: 4, line_end: 4 },
        ]);
    });

    it('emits the raw token even for an unqualified FROM (resolution filters it)', () => {
        const out = parseDockerfile('FROM builder', 'Dockerfile');
        expect(out[0].raw_name).toBe('builder');
    });
});
