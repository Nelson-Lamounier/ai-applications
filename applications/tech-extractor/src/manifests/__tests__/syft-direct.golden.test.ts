/** @format */
import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseSyftJson } from '../../extractors/SyftExtractor.js';
import { collectDirectDeps } from '../collectDirectDeps.js';
import { filterSyftDirect } from '../filterSyftDirect.js';

const fx = (n: string) => path.join(__dirname, 'fixtures', n);

describe('golden: frontend-portfolio direct-deps filter', () => {
  it('drops transitive npm utils and keeps the real stack', async () => {
    const pkg = readFileSync(fx('fp-package.json'), 'utf-8');
    const syft = readFileSync(fx('fp-syft.json'), 'utf-8');
    const direct = await collectDirectDeps(['package.json'], async () => pkg);
    const filtered = filterSyftDirect(parseSyftJson(syft), direct).map((r) => r.raw_name).sort();

    for (const noise of ['lru-cache', 'semver', 'chalk', 'glob', 'debug', 'supports-color']) {
      expect(filtered).not.toContain(noise);
    }
    for (const real of ['react', 'tailwindcss', 'zod', 'd3', 'esbuild']) {
      expect(filtered).toContain(real);
    }
  });
});
