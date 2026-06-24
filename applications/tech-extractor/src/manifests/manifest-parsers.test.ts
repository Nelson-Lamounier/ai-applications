/** @format */
import { describe, it, expect } from '@jest/globals';
import { PARSER_SPECS, normalisePython } from './manifest-parsers.js';

function spec(id: string) {
  const s = PARSER_SPECS.find((p) => p.id === id);
  if (!s) throw new Error(`no parser ${id}`);
  return s;
}

describe('npm parser', () => {
  const npm = spec('npm');
  it('matches package.json only', () => {
    expect(npm.matches('package.json')).toBe(true);
    expect(npm.matches('apps/site/package.json')).toBe(true);
    expect(npm.matches('package-lock.json')).toBe(false);
  });
  it('unions all four declared dependency maps', () => {
    const json = JSON.stringify({
      dependencies: { react: '18', 'lru-cache': '*' },        // lru-cache is direct HERE on purpose
      devDependencies: { esbuild: '0' },
      peerDependencies: { 'react-dom': '18' },
      optionalDependencies: { fsevents: '2' },
    });
    expect(npm.parse(json).sort()).toEqual(['esbuild', 'fsevents', 'lru-cache', 'react', 'react-dom']);
  });
  it('returns [] on invalid json (fail-open at collector)', () => {
    expect(npm.parse('not json')).toEqual([]);
  });
});

describe('go parser', () => {
  const go = spec('go');
  it('keeps require entries without // indirect', () => {
    const mod = [
      'module example.com/x', 'go 1.22',
      'require (', '\tgithub.com/spf13/cobra v1.8.0', '\tgithub.com/x/y v1.0.0 // indirect', ')',
      'require github.com/single/dep v1.2.3',
    ].join('\n');
    expect(go.parse(mod).sort()).toEqual(['github.com/single/dep', 'github.com/spf13/cobra']);
  });
});

describe('php parser', () => {
  const php = spec('php');
  it('keeps require + require-dev, drops php/ext-* platform entries', () => {
    const json = JSON.stringify({
      require: { php: '>=8.1', 'ext-json': '*', 'monolog/monolog': '^3' },
      'require-dev': { 'phpunit/phpunit': '^10' },
    });
    expect(php.parse(json).sort()).toEqual(['monolog/monolog', 'phpunit/phpunit']);
  });
});

describe('ruby parser', () => {
  const ruby = spec('ruby');
  it('extracts gem declarations', () => {
    const gemfile = ["source 'https://rubygems.org'", "gem 'rails', '~> 7.1'", 'gem "puma"', '# gem "commented"'].join('\n');
    expect(ruby.parse(gemfile).sort()).toEqual(['puma', 'rails']);
  });
});

describe('python requirements parser', () => {
  const req = spec('python-requirements');
  it('strips version specifiers, extras, and comments; normalises PEP 503', () => {
    const txt = ['Django>=4.2', 'requests[security]==2.31.0', '# a comment', 'PyYAML', '-r other.txt', ''].join('\n');
    expect(req.parse(txt).sort()).toEqual(['django', 'pyyaml', 'requests']);
  });
  it('normalisePython lowercases and collapses [-_.]', () => {
    expect(normalisePython('PyYAML')).toBe('pyyaml');
    expect(normalisePython('typing_extensions')).toBe('typing-extensions');
  });
});
