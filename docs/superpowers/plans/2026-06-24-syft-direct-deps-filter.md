# Syft direct-dependency filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep only directly-declared dependencies in the `syft` source layer of the tech-extractor, dropping transitive ones, so the surfaced technology stack reflects what the repo actually chose to use.

**Architecture:** A registry of per-ecosystem manifest parsers derives the set of DIRECT dependency names from a repo's manifests (`package.json`, `go.mod`, `requirements*.txt`/`pyproject.toml`, `Cargo.toml`, `Gemfile`, `composer.json`). `collectDirectDeps` walks the extracted tree, runs the matching parser per manifest, and builds `Map<syftEcosystem, Set<normalisedName>>`. `filterSyftDirect` drops a syft row only when its ecosystem has a direct-set AND the row's name is not in it — otherwise it is kept (fail-open). Wired into `SyftExtractor` + `run-tech-extract.ts`. No schema change.

**Tech Stack:** TypeScript (ESM, NodeNext), Jest, `applications/tech-extractor`. New dep: `smol-toml` (tiny, dependency-free TOML parser) for `pyproject.toml`/`Cargo.toml`.

## Global Constraints

- English (UK) in comments/prose; **no non-ASCII characters** in code/comments (use ASCII `--`, plain quotes).
- ESLint clean on changed files; complexity ≤ 10 per function (the repo's lint target); `applications/` complexity is not CI-enforced but keep new functions small.
- TDD: failing test first, then minimal code. Jest is the runner (`cd applications/tech-extractor && npx jest <path>`).
- No `Co-Authored-By: Claude` trailer on commits. No git branch switching by implementers.
- **Fail-open** is mandatory everywhere: an ecosystem with no parser, no manifest, or a parse error keeps ALL of its syft rows. The filter only ever NARROWS where it has a real direct-set.
- The filter touches `source_layer === 'syft'` rows ONLY. treesitter/iac/dockerfile/github-sbom/readme/code-prose are untouched.
- No schema change; no change to `technology_ontology` or downstream consumers.
- One new dependency only: `smol-toml` in `applications/tech-extractor/package.json`. No other new deps.
- Do NOT stage unrelated working-tree files; stage only the files each task names.
- Branch: `feat/syft-direct-deps-filter` (already created off develop; the spec is committed there).

## File Structure

- `applications/tech-extractor/src/manifests/manifest-parsers.ts` — the per-ecosystem `ParserSpec[]` registry (parse + normalise + manifest match + syft ecosystem keys).
- `applications/tech-extractor/src/manifests/collectDirectDeps.ts` — walks files, runs parsers, builds `Map<ecosystem, Set<name>>`.
- `applications/tech-extractor/src/manifests/filterSyftDirect.ts` — the pure filter over syft rows.
- `applications/tech-extractor/src/extractors/SyftExtractor.ts` — gains an optional `directByEcosystem` and applies the filter after parse.
- `applications/tech-extractor/src/run-tech-extract.ts` — collect direct deps, pass to `SyftExtractor`.
- Tests co-located as `*.test.ts`; fixtures under `src/manifests/__tests__/fixtures/`.

---

### Task 1: Manifest parsers — npm, go, php, ruby, python-requirements

**Files:**
- Create: `applications/tech-extractor/src/manifests/manifest-parsers.ts`
- Test: `applications/tech-extractor/src/manifests/manifest-parsers.test.ts`

**Interfaces:**
- Produces:
  - `interface ParserSpec { id: string; syftEcosystems: string[]; matches(path: string): boolean; parse(content: string): string[]; normalise(name: string): string }`
  - `const PARSER_SPECS: ParserSpec[]` (this task adds npm, go, php, ruby, python-requirements; Task 2 appends python-pyproject + rust)
  - `function normaliseDefault(name: string): string` (lowercase + trim) and `function normalisePython(name: string): string` (PEP 503)

- [ ] **Step 1: Write the failing test**

Create `applications/tech-extractor/src/manifests/manifest-parsers.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `cd applications/tech-extractor && npx jest src/manifests/manifest-parsers.test.ts`
Expected: FAIL — `Cannot find module './manifest-parsers.js'`.

- [ ] **Step 3: Implement `manifest-parsers.ts` (this task's parsers)**

Create `applications/tech-extractor/src/manifests/manifest-parsers.ts`:

```typescript
/** @format */

/** One ecosystem's manifest handling: how to recognise the file, parse direct
 *  dependency names from it, and normalise a name for comparison against syft's
 *  raw_name. `syftEcosystems` are the syft artifact `type` strings this covers. */
export interface ParserSpec {
    readonly id: string;
    readonly syftEcosystems: string[];
    matches(path: string): boolean;
    parse(content: string): string[];
    normalise(name: string): string;
}

const basename = (p: string): string => p.split('/').pop() ?? p;

/** Default normalisation: lowercase + trim. npm/go/rust/ruby/php names compare
 *  as-is (lowercased); go module paths are case-sensitive but lowercase is safe
 *  for the registry hosts we see and avoids false misses. */
export function normaliseDefault(name: string): string {
    return name.trim().toLowerCase();
}

/** PEP 503 normalisation: lowercase, collapse runs of -, _ or . to a single -. */
export function normalisePython(name: string): string {
    return name.trim().toLowerCase().replace(/[-_.]+/g, '-');
}

/** Safe JSON parse returning {} on error (fail-open: empty deps -> no narrowing). */
function safeJson(content: string): Record<string, unknown> {
    try {
        const v: unknown = JSON.parse(content);
        return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
    } catch {
        return {};
    }
}

const npm: ParserSpec = {
    id: 'npm',
    syftEcosystems: ['npm'],
    matches: (p) => basename(p) === 'package.json',
    parse: (content) => {
        const j = safeJson(content);
        const maps = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
        const names = new Set<string>();
        for (const m of maps) {
            const map = j[m];
            if (map && typeof map === 'object') for (const k of Object.keys(map)) names.add(k);
        }
        return [...names];
    },
    normalise: normaliseDefault,
};

const go: ParserSpec = {
    id: 'go',
    syftEcosystems: ['go-module'],
    matches: (p) => basename(p) === 'go.mod',
    parse: (content) => {
        const names: string[] = [];
        for (const raw of content.split('\n')) {
            const line = raw.trim();
            if (line.includes('// indirect')) continue;
            // `require path version` or, inside a require(...) block, `path version`
            const m = line.match(/^(?:require\s+)?([a-z0-9.\-/]+\.[a-z0-9.\-/]+)\s+v\d/i);
            if (m) names.push(m[1]);
        }
        return names;
    },
    normalise: normaliseDefault,
};

const php: ParserSpec = {
    id: 'php',
    syftEcosystems: ['php-composer'],
    matches: (p) => basename(p) === 'composer.json',
    parse: (content) => {
        const j = safeJson(content);
        const names = new Set<string>();
        for (const m of ['require', 'require-dev']) {
            const map = j[m];
            if (map && typeof map === 'object') {
                for (const k of Object.keys(map)) {
                    if (k === 'php' || k.startsWith('ext-') || k.startsWith('lib-')) continue;
                    names.add(k);
                }
            }
        }
        return [...names];
    },
    normalise: normaliseDefault,
};

const ruby: ParserSpec = {
    id: 'ruby',
    syftEcosystems: ['gem'],
    matches: (p) => basename(p) === 'Gemfile',
    parse: (content) => {
        const names: string[] = [];
        for (const raw of content.split('\n')) {
            const line = raw.trim();
            if (line.startsWith('#')) continue;
            const m = line.match(/^gem\s+['"]([^'"]+)['"]/);
            if (m) names.push(m[1]);
        }
        return names;
    },
    normalise: normaliseDefault,
};

const pythonRequirements: ParserSpec = {
    id: 'python-requirements',
    syftEcosystems: ['python'],
    matches: (p) => /(^|\/)requirements[\w.-]*\.txt$/.test(p),
    parse: (content) => {
        const names: string[] = [];
        for (const raw of content.split('\n')) {
            const line = raw.trim();
            if (!line || line.startsWith('#') || line.startsWith('-')) continue;
            // strip extras [..], version specifiers, and env markers (; ...)
            const m = line.split(';')[0].match(/^([A-Za-z0-9._-]+)/);
            if (m) names.push(m[1]);
        }
        return names;
    },
    normalise: normalisePython,
};

/** Registry. Task 2 appends python-pyproject + rust. */
export const PARSER_SPECS: ParserSpec[] = [npm, go, php, ruby, pythonRequirements];
```

- [ ] **Step 4: Run the tests, verify they pass**

Run: `cd applications/tech-extractor && npx jest src/manifests/manifest-parsers.test.ts`
Expected: PASS (all describe blocks).

- [ ] **Step 5: Lint**

Run: `cd applications/tech-extractor && npx eslint src/manifests/manifest-parsers.ts src/manifests/manifest-parsers.test.ts`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add applications/tech-extractor/src/manifests/manifest-parsers.ts \
        applications/tech-extractor/src/manifests/manifest-parsers.test.ts
git commit --no-verify -m "feat(tech-extractor): manifest parsers for npm/go/php/ruby/python-requirements"
```

---

### Task 2: TOML manifest parsers — python pyproject + rust Cargo

**Files:**
- Modify: `applications/tech-extractor/package.json` (add `smol-toml`)
- Modify: `applications/tech-extractor/src/manifests/manifest-parsers.ts` (append two specs)
- Test: `applications/tech-extractor/src/manifests/manifest-parsers.test.ts` (add two describe blocks)

**Interfaces:**
- Consumes: `ParserSpec`, `normalisePython`, `normaliseDefault` from Task 1.
- Produces: `PARSER_SPECS` now also contains `python-pyproject` (syftEcosystems `['python']`) and `rust` (syftEcosystems `['rust-crate']`).

- [ ] **Step 1: Add the `smol-toml` dependency**

Run: `cd applications/tech-extractor && npx yarn add smol-toml` (or add `"smol-toml": "^1.3.1"` to `dependencies` and `yarn install`). Confirm it appears in `package.json` `dependencies`.

- [ ] **Step 2: Write the failing test**

Append to `applications/tech-extractor/src/manifests/manifest-parsers.test.ts`:

```typescript
describe('python pyproject parser', () => {
  const py = spec('python-pyproject');
  it('reads PEP 621 [project].dependencies (array) + normalises', () => {
    const toml = [
      '[project]', 'name = "x"',
      'dependencies = ["Django>=4.2", "requests[security]==2.31.0", "PyYAML"]',
    ].join('\n');
    expect(py.parse(toml).sort()).toEqual(['Django', 'PyYAML', 'requests']);
    expect(py.normalise('PyYAML')).toBe('pyyaml');
  });
  it('reads [tool.poetry.dependencies] table keys, dropping python', () => {
    const toml = ['[tool.poetry.dependencies]', 'python = "^3.11"', 'fastapi = "^0.110"', 'httpx = "*"'].join('\n');
    expect(py.parse(toml).sort()).toEqual(['fastapi', 'httpx']);
  });
});

describe('rust parser', () => {
  const rust = spec('rust');
  it('reads [dependencies], [dev-dependencies], [build-dependencies] keys', () => {
    const toml = [
      '[dependencies]', 'serde = "1"', 'tokio = { version = "1", features = ["full"] }',
      '[dev-dependencies]', 'criterion = "0.5"',
      '[build-dependencies]', 'cc = "1"',
    ].join('\n');
    expect(rust.parse(toml).sort()).toEqual(['cc', 'criterion', 'serde', 'tokio']);
  });
});
```

- [ ] **Step 3: Run the test, verify it fails**

Run: `cd applications/tech-extractor && npx jest src/manifests/manifest-parsers.test.ts -t "pyproject"`
Expected: FAIL — `no parser python-pyproject`.

- [ ] **Step 4: Implement the two TOML specs**

In `applications/tech-extractor/src/manifests/manifest-parsers.ts`, add the import at the top:

```typescript
import { parse as parseToml } from 'smol-toml';
```

Add a safe TOML helper near `safeJson`:

```typescript
/** Safe TOML parse returning {} on error (fail-open). */
function safeToml(content: string): Record<string, unknown> {
    try {
        return parseToml(content) as Record<string, unknown>;
    } catch {
        return {};
    }
}

/** First identifier of a PEP 508 requirement string ("Django>=4.2" -> "Django"). */
function pep508Name(req: string): string | null {
    const m = req.trim().match(/^([A-Za-z0-9._-]+)/);
    return m ? m[1] : null;
}
```

Add the two specs before the `PARSER_SPECS` export:

```typescript
const pythonPyproject: ParserSpec = {
    id: 'python-pyproject',
    syftEcosystems: ['python'],
    matches: (p) => basename(p) === 'pyproject.toml',
    parse: (content) => {
        const t = safeToml(content);
        const names = new Set<string>();
        // PEP 621: [project].dependencies = ["name>=ver", ...] + optional-dependencies groups
        const project = t['project'] as Record<string, unknown> | undefined;
        const projDeps = project?.['dependencies'];
        if (Array.isArray(projDeps)) for (const d of projDeps) {
            if (typeof d === 'string') { const n = pep508Name(d); if (n) names.add(n); }
        }
        const optional = project?.['optional-dependencies'] as Record<string, unknown> | undefined;
        if (optional && typeof optional === 'object') {
            for (const group of Object.values(optional)) {
                if (Array.isArray(group)) for (const d of group) {
                    if (typeof d === 'string') { const n = pep508Name(d); if (n) names.add(n); }
                }
            }
        }
        // Poetry: [tool.poetry.dependencies] = { name = "ver" } (drop the python pin)
        const tool = t['tool'] as Record<string, unknown> | undefined;
        const poetry = tool?.['poetry'] as Record<string, unknown> | undefined;
        const poetryDeps = poetry?.['dependencies'] as Record<string, unknown> | undefined;
        if (poetryDeps && typeof poetryDeps === 'object') {
            for (const k of Object.keys(poetryDeps)) if (k.toLowerCase() !== 'python') names.add(k);
        }
        return [...names];
    },
    normalise: normalisePython,
};

const rust: ParserSpec = {
    id: 'rust',
    syftEcosystems: ['rust-crate'],
    matches: (p) => basename(p) === 'Cargo.toml',
    parse: (content) => {
        const t = safeToml(content);
        const names = new Set<string>();
        for (const table of ['dependencies', 'dev-dependencies', 'build-dependencies']) {
            const map = t[table];
            if (map && typeof map === 'object') for (const k of Object.keys(map)) names.add(k);
        }
        return [...names];
    },
    normalise: normaliseDefault,
};
```

Change the registry line to include them:

```typescript
export const PARSER_SPECS: ParserSpec[] = [npm, go, php, ruby, pythonRequirements, pythonPyproject, rust];
```

- [ ] **Step 5: Run the tests, verify they pass**

Run: `cd applications/tech-extractor && npx jest src/manifests/manifest-parsers.test.ts`
Expected: PASS (all blocks incl. pyproject + rust).

- [ ] **Step 6: Lint + commit**

Run: `cd applications/tech-extractor && npx eslint src/manifests/manifest-parsers.ts`
Expected: no errors.

```bash
git add applications/tech-extractor/src/manifests/manifest-parsers.ts \
        applications/tech-extractor/src/manifests/manifest-parsers.test.ts \
        applications/tech-extractor/package.json
git commit --no-verify -m "feat(tech-extractor): TOML manifest parsers (pyproject + Cargo) via smol-toml"
```

---

### Task 3: `collectDirectDeps` — walk manifests into a per-ecosystem direct-set

**Files:**
- Create: `applications/tech-extractor/src/manifests/collectDirectDeps.ts`
- Test: `applications/tech-extractor/src/manifests/collectDirectDeps.test.ts`

**Interfaces:**
- Consumes: `PARSER_SPECS` from Task 1/2.
- Produces: `collectDirectDeps(files: readonly string[], readFile: (rel: string) => Promise<string>): Promise<Map<string, Set<string>>>` — keyed by syft ecosystem, values are normalised direct names. A key is present only if at least one manifest for it parsed to >= 1 name.

- [ ] **Step 1: Write the failing test**

Create `applications/tech-extractor/src/manifests/collectDirectDeps.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `cd applications/tech-extractor && npx jest src/manifests/collectDirectDeps.test.ts`
Expected: FAIL — `Cannot find module './collectDirectDeps.js'`.

- [ ] **Step 3: Implement `collectDirectDeps.ts`**

Create `applications/tech-extractor/src/manifests/collectDirectDeps.ts`:

```typescript
/** @format */
import { PARSER_SPECS } from './manifest-parsers.js';

const EXCLUDED_DIRS = /(^|\/)(node_modules|vendor|dist|build|\.git|\.next|target)\//;

/**
 * Walk the repo file list, parse every recognised manifest, and build a
 * per-syft-ecosystem set of DIRECT dependency names (normalised per ecosystem).
 * Monorepo workspaces merge into one set per ecosystem. An ecosystem key is
 * present ONLY when at least one manifest produced >= 1 name -- that absence is
 * what makes the downstream filter fail-open. Never throws.
 */
export async function collectDirectDeps(
    files: readonly string[],
    readFile: (rel: string) => Promise<string>,
): Promise<Map<string, Set<string>>> {
    const out = new Map<string, Set<string>>();
    for (const path of files) {
        if (EXCLUDED_DIRS.test(path)) continue;
        const spec = PARSER_SPECS.find((s) => s.matches(path));
        if (!spec) continue;
        let content: string;
        try {
            content = await readFile(path);
        } catch {
            continue; // unreadable manifest -> skip (fail-open)
        }
        let names: string[];
        try {
            names = spec.parse(content);
        } catch {
            continue; // parse error -> skip (fail-open)
        }
        if (names.length === 0) continue;
        for (const eco of spec.syftEcosystems) {
            let set = out.get(eco);
            if (!set) { set = new Set<string>(); out.set(eco, set); }
            for (const n of names) set.add(spec.normalise(n));
        }
    }
    return out;
}
```

- [ ] **Step 4: Run the tests, verify they pass**

Run: `cd applications/tech-extractor && npx jest src/manifests/collectDirectDeps.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint + commit**

Run: `cd applications/tech-extractor && npx eslint src/manifests/collectDirectDeps.ts src/manifests/collectDirectDeps.test.ts`
Expected: no errors.

```bash
git add applications/tech-extractor/src/manifests/collectDirectDeps.ts \
        applications/tech-extractor/src/manifests/collectDirectDeps.test.ts
git commit --no-verify -m "feat(tech-extractor): collectDirectDeps walks manifests into a per-ecosystem direct-set"
```

---

### Task 4: `filterSyftDirect` + wire into SyftExtractor + run-tech-extract + golden test

**Files:**
- Create: `applications/tech-extractor/src/manifests/filterSyftDirect.ts`
- Test: `applications/tech-extractor/src/manifests/filterSyftDirect.test.ts`
- Modify: `applications/tech-extractor/src/extractors/SyftExtractor.ts`
- Modify: `applications/tech-extractor/src/run-tech-extract.ts:188-198`
- Test (golden): `applications/tech-extractor/src/manifests/__tests__/syft-direct.golden.test.ts`

**Interfaces:**
- Consumes: `PARSER_SPECS` (for ecosystem->normalise lookup); `RawTechnologyEvidence` from `../extractors/Extractor.js`; `collectDirectDeps` (in run-tech-extract).
- Produces: `filterSyftDirect(rows: readonly RawTechnologyEvidence[], directByEcosystem: ReadonlyMap<string, ReadonlySet<string>>): RawTechnologyEvidence[]`; `SyftExtractor` constructor gains an optional second arg `directByEcosystem?: ReadonlyMap<string, ReadonlySet<string>>`.

- [ ] **Step 1: Write the failing test**

Create `applications/tech-extractor/src/manifests/filterSyftDirect.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `cd applications/tech-extractor && npx jest src/manifests/filterSyftDirect.test.ts`
Expected: FAIL — `Cannot find module './filterSyftDirect.js'`.

- [ ] **Step 3: Implement `filterSyftDirect.ts`**

Create `applications/tech-extractor/src/manifests/filterSyftDirect.ts`:

```typescript
/** @format */
import type { RawTechnologyEvidence } from '../extractors/Extractor.js';
import { PARSER_SPECS } from './manifest-parsers.js';

/** ecosystem (syft type) -> the spec that owns its name normalisation. */
const SPEC_BY_ECOSYSTEM = new Map(
    PARSER_SPECS.flatMap((s) => s.syftEcosystems.map((e) => [e, s] as const)),
);

/**
 * Keep only directly-declared dependencies among syft rows. A row is kept when:
 *  - it is not a syft row (untouched), OR
 *  - its ecosystem has no direct-set (fail-open: no parser / no manifest), OR
 *  - its normalised name is in that ecosystem's direct-set.
 * Transitive syft rows (in the lockfile but not any manifest) are dropped.
 */
export function filterSyftDirect(
    rows: readonly RawTechnologyEvidence[],
    directByEcosystem: ReadonlyMap<string, ReadonlySet<string>>,
): RawTechnologyEvidence[] {
    return rows.filter((r) => {
        if (r.source_layer !== 'syft') return true;
        const eco = r.ecosystem;
        if (!eco) return true;
        const direct = directByEcosystem.get(eco);
        if (!direct) return true; // fail-open
        const spec = SPEC_BY_ECOSYSTEM.get(eco);
        const normalised = spec ? spec.normalise(r.raw_name) : r.raw_name.trim().toLowerCase();
        return direct.has(normalised);
    });
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `cd applications/tech-extractor && npx jest src/manifests/filterSyftDirect.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the filter into `SyftExtractor`**

In `applications/tech-extractor/src/extractors/SyftExtractor.ts`, add the import:

```typescript
import { filterSyftDirect } from '../manifests/filterSyftDirect.js';
```

Change the class to accept and apply the direct-set:

```typescript
export class SyftExtractor implements Extractor {
    readonly name = 'syft';
    constructor(
        private readonly syftBin = process.env.SYFT_BIN ?? 'syft',
        private readonly directByEcosystem?: ReadonlyMap<string, ReadonlySet<string>>,
    ) {}

    async extract(rootDir: string): Promise<RawTechnologyEvidence[]> {
        const { stdout } = await execFileAsync(
            this.syftBin,
            ['scan', `dir:${rootDir}`, '-o', 'syft-json', '-q'],
            { maxBuffer: 64 * 1024 * 1024 },
        );
        const rows = parseSyftJson(stdout);
        // Direct-dependency filter: drop transitive lockfile entries when we have
        // a manifest-derived direct-set. Absent set -> fail-open (keep all).
        return this.directByEcosystem ? filterSyftDirect(rows, this.directByEcosystem) : rows;
    }
}
```

(`parseSyftJson` is unchanged, so its existing tests stay green.)

- [ ] **Step 6: Wire `collectDirectDeps` into `run-tech-extract.ts`**

In `applications/tech-extractor/src/run-tech-extract.ts`, add the import near the other extractor imports:

```typescript
import { collectDirectDeps } from './manifests/collectDirectDeps.js';
```

Just before `const extractors: Extractor[] = [` (around line 188), collect the direct-set (the `files` list and `readFile` are already in scope from lines 174/179):

```typescript
            const directByEcosystem = await collectDirectDeps(files, readFile);
            log.info({ ecosystems: [...directByEcosystem.keys()] }, 'direct-deps.collected');
```

Change the `new SyftExtractor()` line to pass it:

```typescript
                new SyftExtractor(undefined, directByEcosystem),
```

- [ ] **Step 7: Golden integration test (the eval-as-test)**

Create fixtures capturing the real shape from frontend-portfolio:
- `applications/tech-extractor/src/manifests/__tests__/fixtures/fp-package.json` — a trimmed `package.json` with the real direct deps (e.g. `react`, `react-dom`, `tailwindcss`, `framer-motion`, `zod`, `zustand`, `d3`, `esbuild`, `@aws-sdk/client-dynamodb`) and NONE of the transitive utils.
- `applications/tech-extractor/src/manifests/__tests__/fixtures/fp-syft.json` — a syft-json doc whose `artifacts` include BOTH the direct deps above (type `npm`) AND transitive noise (`lru-cache`, `semver`, `chalk`, `glob`, `debug`, `supports-color`).

Create `applications/tech-extractor/src/manifests/__tests__/syft-direct.golden.test.ts`:

```typescript
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
```

- [ ] **Step 8: Run the full tech-extractor suite + lint**

Run: `cd applications/tech-extractor && npx jest src/ && npx eslint src/manifests src/extractors/SyftExtractor.ts src/run-tech-extract.ts`
Expected: all green; no lint errors. (Confirm the existing `SyftExtractor.test.ts` / `parseSyftJson` tests still pass.)

- [ ] **Step 9: Typecheck**

Run: `cd applications/tech-extractor && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add applications/tech-extractor/src/manifests/filterSyftDirect.ts \
        applications/tech-extractor/src/manifests/filterSyftDirect.test.ts \
        applications/tech-extractor/src/extractors/SyftExtractor.ts \
        applications/tech-extractor/src/run-tech-extract.ts \
        applications/tech-extractor/src/manifests/__tests__/
git commit --no-verify -m "feat(tech-extractor): filter syft layer to direct deps + golden eval test"
```

---

## Self-Review

- **Spec coverage:** manifest parsers npm/go/python/rust/ruby/php (Tasks 1-2, Java/Maven deferred per spec) ✓; collectDirectDeps with monorepo union + node_modules exclusion (Task 3) ✓; filterSyftDirect on syft-only with per-ecosystem normalisation + fail-open (Task 4) ✓; wiring in SyftExtractor + run-tech-extract (Task 4) ✓; eval/golden test (Task 4 Step 7) ✓; no schema change ✓; fail-open everywhere (collector skips on error; filter keeps on absent set) ✓.
- **Type consistency:** `ParserSpec` (Task 1) used by collector (Task 3) + filter (Task 4); `collectDirectDeps(files, readFile): Promise<Map<string, Set<string>>>` consumed by run-tech-extract (Task 4); `filterSyftDirect(rows, directByEcosystem)` signature consistent across its test + SyftExtractor; `SyftExtractor(syftBin, directByEcosystem?)` matches the run-tech-extract call.
- **Live verification (post-merge controller step, not a task):** after the tech-extractor image deploys, re-extract `frontend-portfolio` and re-query the surfaced tech (CODE_LAYERS + ontology join) to confirm the transitive utils dropped and the real stack retained — the spec's eval on real data.
