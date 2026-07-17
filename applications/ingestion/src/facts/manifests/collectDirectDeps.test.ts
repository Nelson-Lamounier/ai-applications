/** @format */
import { describe, it, expect } from '@jest/globals';
import { collectDirectDeps } from './collectDirectDeps.js';

function fakeReader(tree: Record<string, string>) {
  return async (rel: string) => {
    const c = tree[rel];
    if (c === undefined) throw new Error(`no file ${rel}`);
    return c;
  };
}

describe('collectDirectDeps', () => {
  it('unions workspace package.json files into one npm set and excludes node_modules', async () => {
    const tree = {
      'package.json': JSON.stringify({ devDependencies: { esbuild: '0' } }),
      'apps/site/package.json': JSON.stringify({ dependencies: { react: '18' } }),
      'node_modules/lodash/package.json': JSON.stringify({ dependencies: { 'lru-cache': '*' } }),
    };
    const map = await collectDirectDeps(Object.keys(tree), fakeReader(tree));
    expect([...(map.get('npm') ?? [])].sort()).toEqual(['esbuild', 'react']);
    // lru-cache from node_modules MUST NOT be present
    expect(map.get('npm')?.has('lru-cache')).toBeFalsy();
  });

  it('keys ecosystems only when a manifest parsed (fail-open driver)', async () => {
    const tree = { 'go.mod': 'module x\nrequire github.com/spf13/cobra v1.8.0\n' };
    const map = await collectDirectDeps(Object.keys(tree), fakeReader(tree));
    expect(map.has('go-module')).toBe(true);
    expect(map.has('npm')).toBe(false); // no package.json -> absent -> npm stays fail-open
  });

  it('never throws when a manifest is unreadable; that ecosystem just stays absent', async () => {
    const reader = async () => { throw new Error('boom'); };
    const map = await collectDirectDeps(['package.json'], reader);
    expect(map.has('npm')).toBe(false);
  });
});
