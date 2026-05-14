import { describe, it, expect } from '@jest/globals';
import { expandQuery } from '../query-expander.js';

describe('expandQuery', () => {
    it('returns a tuple of exactly two strings', () => {
        const result = expandQuery('Tell me about Kubernetes experience');
        expect(result).toHaveLength(2);
        expect(typeof result[0]).toBe('string');
        expect(typeof result[1]).toBe('string');
    });

    it('both expansions are non-empty', () => {
        const [q2, q3] = expandQuery('what is Nelson\'s AWS CDK experience?');
        expect(q2.length).toBeGreaterThan(0);
        expect(q3.length).toBeGreaterThan(0);
    });

    it('outcomes expansion contains reliability/outcomes keywords', () => {
        const [q2] = expandQuery('Kubernetes cluster setup');
        expect(q2).toMatch(/outcome|result|reliab|deploy/i);
    });

    it('architecture expansion contains architecture/pattern keywords', () => {
        const [, q3] = expandQuery('Kubernetes cluster setup');
        expect(q3).toMatch(/architect|pattern|tool|design|infra/i);
    });

    it('strips common stop words from the topic', () => {
        const [q2] = expandQuery('tell me about ArgoCD deployments');
        expect(q2).not.toMatch(/^tell me about/i);
        expect(q2).toContain('ArgoCD');
    });

    it('falls back gracefully on very short input', () => {
        const [q2, q3] = expandQuery('AWS');
        expect(q2.length).toBeGreaterThan(0);
        expect(q3.length).toBeGreaterThan(0);
    });

    it('does not produce leading whitespace when input is empty string', () => {
        const [q2, q3] = expandQuery('');
        expect(q2).not.toMatch(/^\s/);
        expect(q3).not.toMatch(/^\s/);
    });
});
