/** @format */
import { describe, it, expect } from '@jest/globals';
import { computeParity } from './ParityReporter.js';
import { OntologyResolver } from '@bedrock/shared';

describe('computeParity', () => {
    const resolver = new OntologyResolver(new Map([
        ['react', 'id-react'], ['postgres', 'id-pg'], ['kafka', 'id-kafka'], ['k8s', 'id-kube'],
    ]));

    it('recall 1.0 when L1 covers all resolvable LLM techs', () => {
        const r = computeParity(resolver, new Set(['id-react', 'id-pg']), ['react', 'postgres']);
        expect(r.recall).toBeCloseTo(1.0);
        expect(r.intersectionCount).toBe(2);
        expect(r.llmOnlyExamples).toEqual([]);
    });

    it('recall < 1.0 and records the miss', () => {
        const r = computeParity(resolver, new Set(['id-react']), ['react', 'kafka']);
        expect(r.recall).toBeCloseTo(0.5);
        expect(r.llmOnlyExamples).toEqual(['kafka']);
    });

    it('L1 extras recorded, do not affect recall', () => {
        const r = computeParity(resolver, new Set(['id-react', 'id-kube']), ['react']);
        expect(r.recall).toBeCloseTo(1.0);
        expect(r.l1OnlyExamples).toEqual(['id-kube']);
    });

    it('unresolvable LLM strings are excluded from the denominator', () => {
        const r = computeParity(resolver, new Set(['id-react']), ['react', 'some-random-lib']);
        expect(r.llmUnresolvableCount).toBe(1);
        expect(r.recall).toBeCloseTo(1.0);
    });
});
