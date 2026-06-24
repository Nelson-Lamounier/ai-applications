/** @format */
import { describe, it, expect } from '@jest/globals';
import { filterSyftDirect } from './filterSyftDirect.js';
import type { RawTechnologyEvidence } from '../extractors/Extractor.js';

const row = (raw_name: string, ecosystem: string): RawTechnologyEvidence =>
  ({ raw_name, ecosystem, source_layer: 'syft', file_path: '/yarn.lock' });

describe('filterSyftDirect', () => {
  const direct = new Map<string, Set<string>>([['npm', new Set(['react', 'react-dom'])]]);

  it('keeps direct npm rows and drops transitive ones', () => {
    const out = filterSyftDirect([row('react', 'npm'), row('lru-cache', 'npm')], direct);
    expect(out.map((r) => r.raw_name)).toEqual(['react']);
  });

  it('fail-open: keeps ALL rows of an ecosystem with no direct-set', () => {
    const out = filterSyftDirect([row('boto3', 'python'), row('requests', 'python')], direct);
    expect(out.map((r) => r.raw_name).sort()).toEqual(['boto3', 'requests']);
  });

  it('does not touch non-syft rows', () => {
    const treesitter: RawTechnologyEvidence = { raw_name: 'lru-cache', ecosystem: 'npm', source_layer: 'treesitter', file_path: 'x.ts' };
    expect(filterSyftDirect([treesitter], direct)).toEqual([treesitter]);
  });

  it('normalises names per ecosystem before comparing (python PEP 503)', () => {
    const pyDirect = new Map<string, Set<string>>([['python', new Set(['pyyaml'])]]);
    const out = filterSyftDirect([row('PyYAML', 'python'), row('chardet', 'python')], pyDirect);
    expect(out.map((r) => r.raw_name)).toEqual(['PyYAML']);
  });
});
