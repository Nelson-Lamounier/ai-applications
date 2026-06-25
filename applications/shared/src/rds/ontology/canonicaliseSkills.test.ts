/** @format */
import { describe, it, expect, jest } from '@jest/globals';
import { canonicaliseSkills } from './canonicaliseSkills.js';

describe('canonicaliseSkills', () => {
    const alias = new Map([['k8s networking', 'kubernetes networking'], ['cdk', 'iac with cdk']]);

    it('lowercases, trims, drops empties + non-strings, dedups', async () => {
        const out = await canonicaliseSkills(['  REST API  ', '', 'rest api', 42, null]);
        expect(out).toEqual(['rest api']);
    });

    it('stage 2: exact alias wins, collapsing variants to one canonical', async () => {
        const out = await canonicaliseSkills(['K8s Networking', 'kubernetes networking'], alias);
        expect(out).toEqual(['kubernetes networking']);
    });

    it('stage 3: alias-miss falls to the fuzzy resolver, only for misses', async () => {
        const resolveSkill = jest.fn(async (p: string) =>
            p === 'autoscaling groups' ? 'aws auto scaling' : null);
        const out = await canonicaliseSkills(['k8s networking', 'autoscaling groups', 'novel'], alias, resolveSkill);
        expect(out).toEqual(['kubernetes networking', 'aws auto scaling', 'novel']);
        // alias hit never reaches the resolver
        expect(resolveSkill.mock.calls.map((c) => c[0])).toEqual(['autoscaling groups', 'novel']);
    });

    it('resolver errors are non-fatal — raw phrase kept', async () => {
        const resolveSkill = jest.fn(async () => { throw new Error('pgvector down'); });
        expect(await canonicaliseSkills(['weird'], new Map(), resolveSkill)).toEqual(['weird']);
    });

    it('no resolver wired => alias-only (query and corpus stay identical when both omit it)', async () => {
        expect(await canonicaliseSkills(['cdk', 'unknown'], alias)).toEqual(['iac with cdk', 'unknown']);
    });

    describe('onUnresolved control-data hook', () => {
        it('fires only for a genuine unknown (resolver present, returned null)', async () => {
            const resolveSkill = jest.fn(async (p: string) => (p === 'known' ? 'canon' : null));
            const onUnresolved = jest.fn();
            await canonicaliseSkills(['known', 'mystery-tool'], alias, resolveSkill, onUnresolved);
            expect(onUnresolved.mock.calls.map((c) => c[0])).toEqual(['mystery-tool']);
        });

        it('does not fire on an alias hit or a successful fold', async () => {
            const resolveSkill = jest.fn(async () => 'folded');
            const onUnresolved = jest.fn();
            await canonicaliseSkills(['cdk', 'phrase'], alias, resolveSkill, onUnresolved);
            expect(onUnresolved).not.toHaveBeenCalled();
        });

        it('does not fire when no resolver is supplied (alias-only mode)', async () => {
            const onUnresolved = jest.fn();
            await canonicaliseSkills(['unknown'], alias, undefined, onUnresolved);
            expect(onUnresolved).not.toHaveBeenCalled();
        });

        it('swallows a throwing callback (capture never affects canonicalisation)', async () => {
            const resolveSkill = jest.fn(async () => null);
            const out = await canonicaliseSkills(['x'], new Map(), resolveSkill, () => { throw new Error('boom'); });
            expect(out).toEqual(['x']);
        });
    });
});
