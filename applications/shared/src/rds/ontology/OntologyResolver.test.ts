/** @format */
import { describe, it, expect } from '@jest/globals';
import { OntologyResolver, normalizeAlias } from './OntologyResolver.js';

describe('normalizeAlias', () => {
    it('lowercases and trims', () => {
        expect(normalizeAlias('  React.JS ')).toBe('react.js');
    });
});

describe('OntologyResolver', () => {
    const resolver = new OntologyResolver(new Map([
        ['k8s', 'tech-kube'],
        ['kubernetes', 'tech-kube'],
        ['react', 'tech-react'],
    ]));

    it('resolves a known alias to its technology id', () => {
        expect(resolver.resolve('Kubernetes')).toBe('tech-kube');
        expect(resolver.resolve('K8s')).toBe('tech-kube');
    });

    it('returns null for an unknown token (strict — no fuzzy)', () => {
        expect(resolver.resolve('reach')).toBeNull();
        expect(resolver.resolve('kubernetex')).toBeNull();
    });

    it('normalizes input before lookup', () => {
        expect(resolver.resolve('  REACT ')).toBe('tech-react');
    });
});
