# Tech Extractor Layer 1 — Plan 2: Extraction App (`@bedrock/tech-extractor`)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `@bedrock/tech-extractor` workspace: download a repo tarball, extract it safely, run the deterministic extractors (Syft, Tree-sitter, IaC parsers), resolve tokens against the ontology, persist evidence + candidates, and emit a parity report against the LLM enricher.

**Architecture:** A K8s-Job entrypoint (`run-tech-extract.ts`) orchestrates: tarball → safe extract → `Promise.allSettled` over extractors implementing one `Extractor` interface → `OntologyResolver` → `Technology*Repository` writes → `ParityReporter`. Each extractor is independently fault-isolated; one failure degrades data, never the Job.

**Tech Stack:** TypeScript (CommonJS), Node 22 (global `fetch`), `tar`, `web-tree-sitter` (wasm grammars), `pg`, jest, `prom-client`, OpenTelemetry (reused from `@bedrock/shared`).

**Depends on:** Plan 1 (migration 034 + `@bedrock/shared` exports: `OntologyResolver`, `Technology*Repository`, `SourceLayer`, `RawTechnologyEvidence`, `TechnologyEvidenceRow`, `ParityRunRow`, `CONFIDENCE_BY_LAYER`).

**Spec:** `docs/superpowers/specs/2026-05-25-tech-extractor-layer1-design.md`

> **Subprocess safety note:** Syft is invoked with `promisify(execFile)` — array args, **no shell** (`execFile`, not `exec`), so the repo path / model id cannot be shell-injected. The repo has no `execFileNoThrow` helper, so `execFile` is the safe primitive here.

---

## File Structure

- Create `applications/tech-extractor/package.json`, `tsconfig.json`, `jest.config.js`
- Create `applications/tech-extractor/src/env.ts`
- Create `applications/tech-extractor/src/extractors/Extractor.ts` (interface)
- Create `applications/tech-extractor/src/tarball/fetchTarball.ts` (+ test)
- Create `applications/tech-extractor/src/tarball/safeExtract.ts` (+ test)
- Create `applications/tech-extractor/src/util/fileWalk.ts` (+ test)
- Create `applications/tech-extractor/src/extractors/SyftExtractor.ts` (+ test)
- Create `applications/tech-extractor/src/extractors/TreeSitterExtractor.ts` (+ test)
- Create `applications/tech-extractor/src/config/sdkCallPatterns.json`
- Create `applications/tech-extractor/src/extractors/iac/DockerfileParser.ts` (+ test)
- Create `applications/tech-extractor/src/extractors/iac/K8sManifestParser.ts` (+ test)
- Create `applications/tech-extractor/src/extractors/iac/TerraformParser.ts` (+ test)
- Create `applications/tech-extractor/src/extractors/iac/GithubActionsParser.ts` (+ test)
- Create `applications/tech-extractor/src/extractors/iac/ReadmeParser.ts` (+ test)
- Create `applications/tech-extractor/src/orchestrator/TechExtractOrchestrator.ts` (+ test)
- Create `applications/tech-extractor/src/parity/ParityReporter.ts` (+ test)
- Create `applications/tech-extractor/src/run-tech-extract.ts`
- Modify root `package.json` workspaces glob if it does not already glob `applications/*`

---

## Task 1: Scaffold the workspace

**Files:**
- Create: `applications/tech-extractor/package.json`, `applications/tech-extractor/tsconfig.json`, `applications/tech-extractor/jest.config.js`

- [ ] **Step 1: package.json** (mirror `applications/ingestion/package.json`)

```json
{
  "name": "@bedrock/tech-extractor",
  "version": "1.0.0",
  "type": "commonjs",
  "private": true,
  "main": "dist/run-tech-extract.js",
  "scripts": {
    "test": "jest --passWithNoTests",
    "build": "tsc",
    "lint": "tsc --noEmit"
  },
  "dependencies": {
    "@bedrock/shared": "workspace:*",
    "pg": "^8.20.0",
    "prom-client": "^15.1.3",
    "tar": "^7.4.3",
    "web-tree-sitter": "^0.25.0",
    "yaml": "^2.6.0"
  },
  "devDependencies": {
    "@jest/globals": "^29.7.0",
    "@types/node": "^22.0.0",
    "jest": "^29.7.0",
    "ts-jest": "^29.2.0",
    "typescript": "^5.6.0"
  }
}
```

> Verify each version against the root `yarn.lock` before writing — match the versions other workspaces already pin (copy `jest`, `ts-jest`, `typescript`, `@types/node` from `applications/ingestion/package.json`). `tar`, `web-tree-sitter`, `yaml` are new; pick current stable and let `yarn install` resolve.

- [ ] **Step 2: tsconfig.json** (copy `applications/ingestion/tsconfig.json`, confirm `references` includes `../shared`, add `resolveJsonModule`)

```json
{
  "extends": "../tsconfig.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "composite": true,
    "resolveJsonModule": true
  },
  "references": [{ "path": "../shared" }],
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: jest.config.js** (copy `applications/ingestion/jest.config.js` verbatim)

- [ ] **Step 4: Install + verify the workspace resolves**

Run: `yarn install && yarn workspace @bedrock/tech-extractor build`
Expected: install succeeds; tsc runs (an empty entrypoint may warn "no inputs"; OK at this step).

- [ ] **Step 5: Commit**

```bash
git add applications/tech-extractor/package.json applications/tech-extractor/tsconfig.json applications/tech-extractor/jest.config.js package.json yarn.lock
git commit -m "chore(tech-extractor): scaffold @bedrock/tech-extractor workspace"
```

---

## Task 2: Extractor interface + env

**Files:**
- Create: `applications/tech-extractor/src/extractors/Extractor.ts`
- Create: `applications/tech-extractor/src/env.ts`

- [ ] **Step 1: Extractor.ts**

```ts
/** @format */
import type { RawTechnologyEvidence } from '@bedrock/shared';

export type { RawTechnologyEvidence };

/** Every deterministic extractor implements this. Pure over a directory. */
export interface Extractor {
    readonly name: string;
    extract(rootDir: string): Promise<RawTechnologyEvidence[]>;
}
```

- [ ] **Step 2: env.ts** (mirror `applications/ingestion/src/env.ts`)

```ts
/** @format */

export interface TechExtractEnv {
    readonly userId:       string;
    readonly repoFullName: string;
    readonly commitSha?:   string;
    readonly githubToken:  string;
    readonly workDir:      string;
    readonly pg: {
        readonly host: string; readonly port: number; readonly database: string;
        readonly user: string; readonly password: string;
    };
}

function required(name: string): string {
    const v = process.env[name];
    if (!v) throw new Error(`Missing required env var: ${name}`);
    return v;
}

export function parseEnv(): TechExtractEnv {
    return {
        userId:       required('USER_ID'),
        repoFullName: required('REPO_FULL_NAME'),
        commitSha:    process.env['COMMIT_SHA'] || undefined,
        githubToken:  required('GITHUB_TOKEN'),
        workDir:      process.env['WORK_DIR'] ?? '/work',
        pg: {
            host:     required('PG_HOST'),
            port:     Number.parseInt(process.env['PG_PORT'] ?? '5432', 10),
            database: required('PG_DATABASE'),
            user:     required('PG_USER'),
            password: required('PG_PASSWORD'),
        },
    };
}
```

- [ ] **Step 3: Commit**

```bash
git add applications/tech-extractor/src/extractors/Extractor.ts applications/tech-extractor/src/env.ts
git commit -m "feat(tech-extractor): add Extractor interface and env parser"
```

---

## Task 3: fetchTarball

**Files:**
- Create: `applications/tech-extractor/src/tarball/fetchTarball.ts`
- Test: `applications/tech-extractor/src/tarball/fetchTarball.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
/** @format */
import { describe, it, expect, jest, afterEach } from '@jest/globals';
import { tarballUrl, fetchTarball } from './fetchTarball.js';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('tarballUrl', () => {
    it('builds the api url for a ref', () => {
        expect(tarballUrl('owner/repo', 'main')).toBe('https://api.github.com/repos/owner/repo/tarball/main');
    });
    it('defaults ref to HEAD when omitted', () => {
        expect(tarballUrl('owner/repo')).toBe('https://api.github.com/repos/owner/repo/tarball/HEAD');
    });
});

describe('fetchTarball', () => {
    const realFetch = globalThis.fetch;
    afterEach(() => { globalThis.fetch = realFetch; });

    it('writes the response body to disk with auth + size guard', async () => {
        const body = Buffer.from('fake-tar-bytes');
        globalThis.fetch = jest.fn(async () => new Response(body, {
            status: 200, headers: { 'content-length': String(body.length) },
        })) as never;

        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tball-'));
        const out = path.join(dir, 'repo.tar.gz');
        await fetchTarball('owner/repo', 'main', 'tok', out, 1024 * 1024);

        const written = await fs.readFile(out);
        expect(written.equals(body)).toBe(true);
        const call = (globalThis.fetch as jest.Mock).mock.calls[0];
        expect((call[1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer tok' });
        await fs.rm(dir, { recursive: true, force: true });
    });

    it('rejects when content-length exceeds the cap', async () => {
        globalThis.fetch = jest.fn(async () => new Response(Buffer.from('x'), {
            status: 200, headers: { 'content-length': String(5_000_000) },
        })) as never;
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tball-'));
        await expect(
            fetchTarball('owner/repo', 'main', 'tok', path.join(dir, 'r.tar.gz'), 1_000_000),
        ).rejects.toThrow(/too large|repo_too_large/i);
        await fs.rm(dir, { recursive: true, force: true });
    });

    it('throws on non-200', async () => {
        globalThis.fetch = jest.fn(async () => new Response('nope', { status: 404 })) as never;
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tball-'));
        await expect(
            fetchTarball('owner/repo', 'main', 'tok', path.join(dir, 'r.tar.gz'), 1_000_000),
        ).rejects.toThrow(/404/);
        await fs.rm(dir, { recursive: true, force: true });
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn workspace @bedrock/tech-extractor jest src/tarball/fetchTarball.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
/** @format */
import { promises as fs } from 'node:fs';

export function tarballUrl(repoFullName: string, ref = 'HEAD'): string {
    return `https://api.github.com/repos/${repoFullName}/tarball/${ref}`;
}

/**
 * Download a repo tarball to `outPath`. One request per repo; fetch follows the
 * 302 to codeload automatically. Enforces a max-size cap (Content-Length) to
 * defend against runaway repos; throws `repo_too_large` past the cap.
 */
export async function fetchTarball(
    repoFullName: string,
    ref: string | undefined,
    token: string,
    outPath: string,
    maxBytes: number,
): Promise<void> {
    const res = await fetch(tarballUrl(repoFullName, ref ?? 'HEAD'), {
        headers: {
            Authorization: `Bearer ${token}`,
            Accept:        'application/vnd.github+json',
            'User-Agent':  'tucaken-tech-extractor',
        },
        redirect: 'follow',
    });
    if (!res.ok) throw new Error(`tarball fetch failed: HTTP ${res.status}`);

    const len = Number(res.headers.get('content-length') ?? '0');
    if (len > maxBytes) throw new Error(`repo_too_large: ${len} > ${maxBytes}`);
    if (!res.body) throw new Error('tarball fetch returned no body');

    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new Error(`repo_too_large: ${buf.length} > ${maxBytes}`);
    await fs.writeFile(outPath, buf);
}
```

> Phase-1 buffers the tarball in memory before writing (simpler, bounded by `maxBytes`). Streaming with an inline byte counter is a Phase-2 optimization for large caps.

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn workspace @bedrock/tech-extractor jest src/tarball/fetchTarball.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add applications/tech-extractor/src/tarball/fetchTarball.ts applications/tech-extractor/src/tarball/fetchTarball.test.ts
git commit -m "feat(tech-extractor): add tarball fetch with size cap"
```

---

## Task 4: safeExtract

**Files:**
- Create: `applications/tech-extractor/src/tarball/safeExtract.ts`
- Test: `applications/tech-extractor/src/tarball/safeExtract.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
/** @format */
import { describe, it, expect } from '@jest/globals';
import { safeFilter } from './safeExtract.js';

describe('safeFilter', () => {
    it('accepts a normal nested file', () => {
        expect(safeFilter('root-abc/src/index.ts', { type: 'File' } as never)).toBe(true);
    });
    it('rejects path traversal (zip-slip)', () => {
        expect(safeFilter('root-abc/../../etc/passwd', { type: 'File' } as never)).toBe(false);
    });
    it('rejects symlinks and hardlinks', () => {
        expect(safeFilter('root-abc/link', { type: 'SymbolicLink' } as never)).toBe(false);
        expect(safeFilter('root-abc/link', { type: 'Link' } as never)).toBe(false);
    });
    it('rejects absolute paths', () => {
        expect(safeFilter('/etc/passwd', { type: 'File' } as never)).toBe(false);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn workspace @bedrock/tech-extractor jest src/tarball/safeExtract.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
/** @format */
import * as tar from 'tar';

interface TarEntryLike { type: string }

/**
 * Per-entry guard for tar extraction. Rejects symlinks/hardlinks, absolute
 * paths, and `..` traversal (zip-slip). Path is the in-archive path BEFORE
 * strip is applied.
 */
export function safeFilter(entryPath: string, entry: TarEntryLike): boolean {
    if (entry.type === 'SymbolicLink' || entry.type === 'Link') return false;
    if (entryPath.startsWith('/')) return false;
    if (entryPath.split('/').some((seg) => seg === '..')) return false;
    return true;
}

/**
 * Extract a downloaded tarball into `destDir` with safety filters and
 * strip-components 1 (drops the GitHub `{owner}-{repo}-{sha}/` root). Caps the
 * number of entries to defend against zip bombs.
 */
export async function safeExtract(tarballPath: string, destDir: string, maxEntries = 50_000): Promise<void> {
    let count = 0;
    await tar.x({
        file:    tarballPath,
        cwd:     destDir,
        strip:   1,
        strict:  true,
        filter: (p: string, entry: TarEntryLike) => {
            if (++count > maxEntries) throw new Error(`too many tar entries (> ${maxEntries})`);
            return safeFilter(p, entry);
        },
        preserveOwner: false,
        noChmod:       true,
    } as tar.ExtractOptions & { filter: (p: string, e: TarEntryLike) => boolean });
}
```

> Verify the exact `tar` v7 option names (`strip`, `strict`, `filter`, `preserveOwner`, `noChmod`) against the installed version's types during implementation; adjust if the API differs.

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn workspace @bedrock/tech-extractor jest src/tarball/safeExtract.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add applications/tech-extractor/src/tarball/safeExtract.ts applications/tech-extractor/src/tarball/safeExtract.test.ts
git commit -m "feat(tech-extractor): add guarded tarball extraction"
```

---

## Task 5: fileWalk (text pre-filter)

**Files:**
- Create: `applications/tech-extractor/src/util/fileWalk.ts`
- Test: `applications/tech-extractor/src/util/fileWalk.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
/** @format */
import { describe, it, expect } from '@jest/globals';
import { isTextCandidate } from './fileWalk.js';

describe('isTextCandidate', () => {
    it('accepts source + config extensions', () => {
        for (const f of ['a.ts','b.py','c.go','d.rs','e.java','Dockerfile','f.tf','g.yaml','README.md']) {
            expect(isTextCandidate(f)).toBe(true);
        }
    });
    it('rejects binaries and images', () => {
        for (const f of ['x.png','y.jpg','z.pdf','w.so','v.wasm']) {
            expect(isTextCandidate(f)).toBe(false);
        }
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn workspace @bedrock/tech-extractor jest src/util/fileWalk.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
/** @format */
import { promises as fs } from 'node:fs';
import path from 'node:path';

const TEXT_EXT = new Set([
    '.ts','.tsx','.js','.jsx','.py','.go','.rs','.java',
    '.tf','.hcl','.yaml','.yml','.json','.toml','.md','.sh',
]);
const SPECIAL_NAMES = new Set(['dockerfile']);

/** Cheap extension/name filter for the text-oriented extractors. */
export function isTextCandidate(filePath: string): boolean {
    const base = path.basename(filePath).toLowerCase();
    if (SPECIAL_NAMES.has(base) || base.startsWith('dockerfile')) return true;
    return TEXT_EXT.has(path.extname(base));
}

/** Recursively list text-candidate files under root, returning repo-relative paths. */
export async function walkTextFiles(rootDir: string): Promise<string[]> {
    const out: string[] = [];
    async function rec(dir: string): Promise<void> {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const e of entries) {
            if (e.name === '.git' || e.name === 'node_modules') continue;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) { await rec(full); continue; }
            if (e.isFile() && isTextCandidate(e.name)) out.push(path.relative(rootDir, full));
        }
    }
    await rec(rootDir);
    return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn workspace @bedrock/tech-extractor jest src/util/fileWalk.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add applications/tech-extractor/src/util/fileWalk.ts applications/tech-extractor/src/util/fileWalk.test.ts
git commit -m "feat(tech-extractor): add text-file walk filter"
```

---

## Task 6: SyftExtractor

**Files:**
- Create: `applications/tech-extractor/src/extractors/SyftExtractor.ts`
- Test: `applications/tech-extractor/src/extractors/SyftExtractor.test.ts`
- Test fixture: `applications/tech-extractor/src/extractors/__tests__/fixtures/syft-output.json`

- [ ] **Step 1: Create the fixture** (`syft-output.json`)

```json
{
  "artifacts": [
    { "name": "react", "version": "18.2.0", "type": "npm",
      "locations": [{ "path": "package.json" }] },
    { "name": "boto3", "version": "1.34.0", "type": "python",
      "locations": [{ "path": "requirements.txt" }] }
  ]
}
```

- [ ] **Step 2: Write the failing test** (tests the pure parser — no binary needed)

```ts
/** @format */
import { describe, it, expect } from '@jest/globals';
import { parseSyftJson } from './SyftExtractor.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('parseSyftJson', () => {
    it('maps syft artifacts to RawTechnologyEvidence with provenance', () => {
        const json = readFileSync(path.join(__dirname, '__tests__/fixtures/syft-output.json'), 'utf-8');
        const out = parseSyftJson(json);
        expect(out).toHaveLength(2);
        expect(out[0]).toMatchObject({
            raw_name: 'react', ecosystem: 'npm', source_layer: 'syft', file_path: 'package.json',
        });
        expect(out[1]).toMatchObject({ raw_name: 'boto3', ecosystem: 'python', source_layer: 'syft' });
    });

    it('returns [] for empty or non-JSON input', () => {
        expect(parseSyftJson('{}')).toEqual([]);
        expect(parseSyftJson('not json')).toEqual([]);
    });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `yarn workspace @bedrock/tech-extractor jest src/extractors/SyftExtractor.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Write the implementation**

```ts
/** @format */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Extractor, RawTechnologyEvidence } from './Extractor.js';

// execFile (NOT exec): array args, no shell — the repo path/binary cannot be
// shell-injected. The repo has no execFileNoThrow helper, so this is the safe
// primitive. Never switch this to exec().
const execFileAsync = promisify(execFile);

interface SyftArtifact { name?: string; type?: string; locations?: { path?: string }[] }

/** Pure parser — unit-testable without invoking the syft binary. */
export function parseSyftJson(stdout: string): RawTechnologyEvidence[] {
    let doc: { artifacts?: SyftArtifact[] };
    try { doc = JSON.parse(stdout); } catch { return []; }
    const out: RawTechnologyEvidence[] = [];
    for (const a of doc.artifacts ?? []) {
        if (!a.name) continue;
        out.push({
            raw_name:     a.name,
            ecosystem:    a.type,
            source_layer: 'syft',
            file_path:    a.locations?.[0]?.path ?? '(unknown)',
        });
    }
    return out;
}

export class SyftExtractor implements Extractor {
    readonly name = 'syft';
    constructor(private readonly syftBin = process.env.SYFT_BIN ?? 'syft') {}

    async extract(rootDir: string): Promise<RawTechnologyEvidence[]> {
        const { stdout } = await execFileAsync(
            this.syftBin,
            ['scan', `dir:${rootDir}`, '-o', 'syft-json', '-q'],
            { maxBuffer: 64 * 1024 * 1024 },
        );
        return parseSyftJson(stdout);
    }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `yarn workspace @bedrock/tech-extractor jest src/extractors/SyftExtractor.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add applications/tech-extractor/src/extractors/SyftExtractor.ts applications/tech-extractor/src/extractors/SyftExtractor.test.ts applications/tech-extractor/src/extractors/__tests__/fixtures/syft-output.json
git commit -m "feat(tech-extractor): add SyftExtractor + JSON parser"
```

---

## Task 7: IaC — DockerfileParser

**Files:**
- Create: `applications/tech-extractor/src/extractors/iac/DockerfileParser.ts`
- Test: `applications/tech-extractor/src/extractors/iac/DockerfileParser.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn workspace @bedrock/tech-extractor jest src/extractors/iac/DockerfileParser.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
/** @format */
import type { RawTechnologyEvidence } from '../Extractor.js';

/** Pull base-image names from FROM lines. `node:22-alpine` -> `node`. */
export function parseDockerfile(src: string, filePath: string): RawTechnologyEvidence[] {
    const out: RawTechnologyEvidence[] = [];
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const m = /^\s*FROM\s+([^\s]+)/i.exec(lines[i]);
        if (!m) continue;
        const image = m[1].split('@')[0].split(':')[0].split('/').pop()!;
        out.push({
            raw_name: image, ecosystem: 'docker', source_layer: 'dockerfile',
            file_path: filePath, line_start: i + 1, line_end: i + 1,
        });
    }
    return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn workspace @bedrock/tech-extractor jest src/extractors/iac/DockerfileParser.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add applications/tech-extractor/src/extractors/iac/DockerfileParser.ts applications/tech-extractor/src/extractors/iac/DockerfileParser.test.ts
git commit -m "feat(tech-extractor): add Dockerfile base-image parser"
```

---

## Task 8: IaC — K8sManifestParser

**Files:**
- Create: `applications/tech-extractor/src/extractors/iac/K8sManifestParser.ts`
- Test: `applications/tech-extractor/src/extractors/iac/K8sManifestParser.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
/** @format */
import { describe, it, expect } from '@jest/globals';
import { parseK8sManifest } from './K8sManifestParser.js';

describe('parseK8sManifest', () => {
    it('emits kubernetes + container images for a Deployment', () => {
        const yaml = [
            'apiVersion: apps/v1',
            'kind: Deployment',
            'spec:',
            '  template:',
            '    spec:',
            '      containers:',
            '        - image: redis:7',
        ].join('\n');
        const out = parseK8sManifest(yaml, 'deploy.yaml');
        const names = out.map(o => o.raw_name);
        expect(names).toContain('kubernetes');
        expect(names).toContain('redis');
        expect(out.every(o => o.source_layer === 'iac' && o.file_path === 'deploy.yaml')).toBe(true);
    });

    it('returns [] for non-k8s yaml', () => {
        expect(parseK8sManifest('name: ci\non: push', 'ci.yaml')).toEqual([]);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn workspace @bedrock/tech-extractor jest src/extractors/iac/K8sManifestParser.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
/** @format */
import { parseAllDocuments } from 'yaml';
import type { RawTechnologyEvidence } from '../Extractor.js';

const K8S_KINDS = new Set([
    'Deployment','StatefulSet','DaemonSet','Job','CronJob','Service','Ingress','Pod',
]);

/** Detect k8s manifests; emit a 'kubernetes' token + each container image name. */
export function parseK8sManifest(src: string, filePath: string): RawTechnologyEvidence[] {
    const out: RawTechnologyEvidence[] = [];
    let docs;
    try { docs = parseAllDocuments(src); } catch { return []; }
    let isK8s = false;
    for (const d of docs) {
        const obj = d.toJSON() as { kind?: string } | null;
        if (obj?.kind && K8S_KINDS.has(obj.kind)) {
            isK8s = true;
            for (const img of collectImages(obj)) {
                const name = img.split('@')[0].split(':')[0].split('/').pop()!;
                out.push({ raw_name: name, ecosystem: 'docker', source_layer: 'iac', file_path: filePath });
            }
        }
    }
    if (isK8s) out.unshift({ raw_name: 'kubernetes', ecosystem: 'iac', source_layer: 'iac', file_path: filePath });
    return out;
}

function collectImages(node: unknown): string[] {
    const images: string[] = [];
    (function rec(n: unknown): void {
        if (Array.isArray(n)) { n.forEach(rec); return; }
        if (n && typeof n === 'object') {
            for (const [k, v] of Object.entries(n)) {
                if (k === 'image' && typeof v === 'string') images.push(v);
                else rec(v);
            }
        }
    })(node);
    return images;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn workspace @bedrock/tech-extractor jest src/extractors/iac/K8sManifestParser.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add applications/tech-extractor/src/extractors/iac/K8sManifestParser.ts applications/tech-extractor/src/extractors/iac/K8sManifestParser.test.ts
git commit -m "feat(tech-extractor): add k8s manifest parser"
```

---

## Task 9: IaC — TerraformParser

**Files:**
- Create: `applications/tech-extractor/src/extractors/iac/TerraformParser.ts`
- Test: `applications/tech-extractor/src/extractors/iac/TerraformParser.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
/** @format */
import { describe, it, expect } from '@jest/globals';
import { parseTerraform } from './TerraformParser.js';

describe('parseTerraform', () => {
    it('extracts resource declarations + a terraform token', () => {
        const src = [
            'resource "aws_lambda_function" "fn" {}',
            'resource "google_storage_bucket" "b" {}',
        ].join('\n');
        const out = parseTerraform(src, 'main.tf');
        const names = out.map(o => o.raw_name);
        expect(names).toContain('terraform');
        expect(names).toContain('aws_lambda_function');
        expect(names).toContain('google_storage_bucket');
        expect(out.every(o => o.source_layer === 'iac')).toBe(true);
    });

    it('returns [] when there are no resource blocks', () => {
        expect(parseTerraform('variable "x" {}', 'vars.tf')).toEqual([]);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn workspace @bedrock/tech-extractor jest src/extractors/iac/TerraformParser.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
/** @format */
import type { RawTechnologyEvidence } from '../Extractor.js';

/** Extract `resource "<type>" "<name>"` declarations + a terraform token. */
export function parseTerraform(src: string, filePath: string): RawTechnologyEvidence[] {
    const out: RawTechnologyEvidence[] = [];
    const lines = src.split('\n');
    let matched = false;
    for (let i = 0; i < lines.length; i++) {
        const m = /^\s*resource\s+"([a-z0-9_]+)"/i.exec(lines[i]);
        if (!m) continue;
        matched = true;
        out.push({
            raw_name: m[1], ecosystem: 'terraform', source_layer: 'iac',
            file_path: filePath, line_start: i + 1, line_end: i + 1,
        });
    }
    if (matched) out.unshift({ raw_name: 'terraform', ecosystem: 'iac', source_layer: 'iac', file_path: filePath });
    return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn workspace @bedrock/tech-extractor jest src/extractors/iac/TerraformParser.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add applications/tech-extractor/src/extractors/iac/TerraformParser.ts applications/tech-extractor/src/extractors/iac/TerraformParser.test.ts
git commit -m "feat(tech-extractor): add terraform resource parser"
```

---

## Task 10: IaC — GithubActionsParser

**Files:**
- Create: `applications/tech-extractor/src/extractors/iac/GithubActionsParser.ts`
- Test: `applications/tech-extractor/src/extractors/iac/GithubActionsParser.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
/** @format */
import { describe, it, expect } from '@jest/globals';
import { parseGithubActions } from './GithubActionsParser.js';

describe('parseGithubActions', () => {
    it('emits github_actions + each used action name', () => {
        const yaml = [
            'on: push',
            'jobs:',
            '  build:',
            '    steps:',
            '      - uses: actions/checkout@v4',
            '      - uses: aws-actions/configure-aws-credentials@v4',
        ].join('\n');
        const out = parseGithubActions(yaml, '.github/workflows/ci.yaml');
        const names = out.map(o => o.raw_name);
        expect(names).toContain('github_actions');
        expect(names).toContain('actions/checkout');
        expect(names).toContain('aws-actions/configure-aws-credentials');
    });

    it('returns [] when there are no uses: lines', () => {
        expect(parseGithubActions('name: x', '.github/workflows/x.yaml')).toEqual([]);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn workspace @bedrock/tech-extractor jest src/extractors/iac/GithubActionsParser.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
/** @format */
import type { RawTechnologyEvidence } from '../Extractor.js';

/** Extract `uses: owner/action@ref` references from a workflow file. */
export function parseGithubActions(src: string, filePath: string): RawTechnologyEvidence[] {
    const out: RawTechnologyEvidence[] = [];
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const m = /^\s*-?\s*uses:\s*([^@\s]+)/.exec(lines[i]);
        if (!m) continue;
        out.push({
            raw_name: m[1], ecosystem: 'github_actions', source_layer: 'iac',
            file_path: filePath, line_start: i + 1, line_end: i + 1,
        });
    }
    if (out.length > 0) out.unshift({ raw_name: 'github_actions', ecosystem: 'iac', source_layer: 'iac', file_path: filePath });
    return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn workspace @bedrock/tech-extractor jest src/extractors/iac/GithubActionsParser.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add applications/tech-extractor/src/extractors/iac/GithubActionsParser.ts applications/tech-extractor/src/extractors/iac/GithubActionsParser.test.ts
git commit -m "feat(tech-extractor): add github actions parser"
```

---

## Task 11: IaC — ReadmeParser

**Files:**
- Create: `applications/tech-extractor/src/extractors/iac/ReadmeParser.ts`
- Test: `applications/tech-extractor/src/extractors/iac/ReadmeParser.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
/** @format */
import { describe, it, expect } from '@jest/globals';
import { parseReadme } from './ReadmeParser.js';

describe('parseReadme', () => {
    it('extracts shields.io badge subjects as readme-layer tokens', () => {
        const md = [
            '# My Project',
            '![build](https://img.shields.io/badge/React-18-blue)',
            '[![pg](https://img.shields.io/badge/PostgreSQL-16-blue)](#)',
        ].join('\n');
        const out = parseReadme(md, 'README.md');
        const names = out.map(o => o.raw_name);
        expect(names).toContain('React');
        expect(names).toContain('PostgreSQL');
        expect(out.every(o => o.source_layer === 'readme')).toBe(true);
    });

    it('returns [] when there are no badges', () => {
        expect(parseReadme('# Title\nsome prose', 'README.md')).toEqual([]);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn workspace @bedrock/tech-extractor jest src/extractors/iac/ReadmeParser.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
/** @format */
import type { RawTechnologyEvidence } from '../Extractor.js';

/** Pull the subject of shields.io badges (`/badge/<subject>-<status>-<color>`). */
export function parseReadme(src: string, filePath: string): RawTechnologyEvidence[] {
    const out: RawTechnologyEvidence[] = [];
    const re = /img\.shields\.io\/badge\/([^-/)]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
        const subject = decodeURIComponent(m[1]).trim();
        if (subject) out.push({ raw_name: subject, ecosystem: 'readme', source_layer: 'readme', file_path: filePath });
    }
    return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn workspace @bedrock/tech-extractor jest src/extractors/iac/ReadmeParser.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add applications/tech-extractor/src/extractors/iac/ReadmeParser.ts applications/tech-extractor/src/extractors/iac/ReadmeParser.test.ts
git commit -m "feat(tech-extractor): add README badge parser"
```

---

## Task 12: TreeSitterExtractor (imports + SDK calls)

**Files:**
- Create: `applications/tech-extractor/src/config/sdkCallPatterns.json`
- Create: `applications/tech-extractor/src/extractors/TreeSitterExtractor.ts`
- Test: `applications/tech-extractor/src/extractors/TreeSitterExtractor.test.ts`

> Phase 1 unit-tests the **pure import/SDK-pattern logic** (`extractImportsByRegex`, `matchSdkCalls`) against source strings. The live Tree-sitter wasm AST pass is a Phase-2 accuracy upgrade behind the same interface; the regex pass is the deterministic fallback.

- [ ] **Step 1: sdkCallPatterns.json**

```json
[
  { "language": "python", "callPattern": "boto3.client", "ecosystem": "aws", "raw_name": "aws" },
  { "language": "python", "callPattern": "boto3.resource", "ecosystem": "aws", "raw_name": "aws" },
  { "language": "javascript", "callPattern": "new BedrockRuntimeClient", "ecosystem": "aws", "raw_name": "aws_bedrock" },
  { "language": "typescript", "callPattern": "new BedrockRuntimeClient", "ecosystem": "aws", "raw_name": "aws_bedrock" }
]
```

- [ ] **Step 2: Write the failing test**

```ts
/** @format */
import { describe, it, expect } from '@jest/globals';
import { extractImportsByRegex, matchSdkCalls } from './TreeSitterExtractor.js';

describe('extractImportsByRegex', () => {
    it('pulls module names from python and js/ts imports', () => {
        const py = 'import os\nfrom django.db import models';
        expect(extractImportsByRegex(py, 'python', 'a.py').map(e => e.raw_name)).toEqual(['os','django']);

        const ts = "import express from 'express';\nimport { z } from 'zod';";
        expect(extractImportsByRegex(ts, 'typescript', 'a.ts').map(e => e.raw_name)).toEqual(['express','zod']);
    });
});

describe('matchSdkCalls', () => {
    it('flags known SDK call patterns', () => {
        const py = "import boto3\ns3 = boto3.client('s3')";
        const out = matchSdkCalls(py, 'python', 'a.py');
        expect(out.map(e => e.raw_name)).toContain('aws');
        expect(out.every(e => e.source_layer === 'treesitter')).toBe(true);
    });
    it('returns [] when no pattern matches', () => {
        expect(matchSdkCalls('print(1)', 'python', 'a.py')).toEqual([]);
    });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `yarn workspace @bedrock/tech-extractor jest src/extractors/TreeSitterExtractor.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Write the implementation**

```ts
/** @format */
import type { Extractor, RawTechnologyEvidence } from './Extractor.js';
import patterns from '../config/sdkCallPatterns.json';

type Lang = 'python' | 'javascript' | 'typescript' | 'go' | 'rust' | 'java';

interface SdkPattern { language: string; callPattern: string; ecosystem: string; raw_name: string }

/**
 * Regex import extraction (deterministic, unit-testable). The Tree-sitter AST
 * pass replaces this in Phase 2 behind the same interface.
 */
export function extractImportsByRegex(src: string, lang: Lang, filePath: string): RawTechnologyEvidence[] {
    const out: RawTechnologyEvidence[] = [];
    const push = (name: string, line: number) =>
        out.push({ raw_name: name, ecosystem: lang, source_layer: 'treesitter', file_path: filePath, line_start: line, line_end: line });
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        if (lang === 'python') {
            let m = /^\s*import\s+([a-zA-Z0-9_]+)/.exec(l);
            if (m) { push(m[1], i + 1); continue; }
            m = /^\s*from\s+([a-zA-Z0-9_]+)/.exec(l);
            if (m) push(m[1], i + 1);
        } else if (lang === 'javascript' || lang === 'typescript') {
            const m = /(?:import|require)\b[^'"]*['"]([^'"]+)['"]/.exec(l);
            if (m) {
                const mod = m[1].startsWith('@') ? m[1].split('/').slice(0, 2).join('/') : m[1].split('/')[0];
                if (!mod.startsWith('.')) push(mod, i + 1);
            }
        }
    }
    return out;
}

/** Substring match of configured SDK-call patterns. */
export function matchSdkCalls(src: string, lang: Lang, filePath: string): RawTechnologyEvidence[] {
    const out: RawTechnologyEvidence[] = [];
    const lines = src.split('\n');
    for (const p of (patterns as SdkPattern[])) {
        if (p.language !== lang) continue;
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes(p.callPattern)) {
                out.push({ raw_name: p.raw_name, ecosystem: p.ecosystem, source_layer: 'treesitter', file_path: filePath, line_start: i + 1, line_end: i + 1 });
            }
        }
    }
    return out;
}

const EXT_LANG: Record<string, Lang> = {
    '.py': 'python', '.js': 'javascript', '.jsx': 'javascript',
    '.ts': 'typescript', '.tsx': 'typescript', '.go': 'go', '.rs': 'rust', '.java': 'java',
};

/** Maps a file extension to a supported language, or null. */
export function langForExt(ext: string): Lang | null {
    return EXT_LANG[ext] ?? null;
}

export class TreeSitterExtractor implements Extractor {
    readonly name = 'treesitter';
    constructor(
        private readonly readFile: (rel: string) => Promise<string>,
        private readonly files: string[],
    ) {}

    async extract(_rootDir: string): Promise<RawTechnologyEvidence[]> {
        const out: RawTechnologyEvidence[] = [];
        for (const rel of this.files) {
            const ext = rel.slice(rel.lastIndexOf('.'));
            const lang = langForExt(ext);
            if (!lang) continue;
            const src = await this.readFile(rel);
            out.push(...extractImportsByRegex(src, lang, rel));
            out.push(...matchSdkCalls(src, lang, rel));
        }
        return out;
    }
}
```

> `resolveJsonModule` (set in Task 1's tsconfig) lets `import patterns from '...json'` resolve.

- [ ] **Step 5: Run test to verify it passes**

Run: `yarn workspace @bedrock/tech-extractor jest src/extractors/TreeSitterExtractor.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add applications/tech-extractor/src/extractors/TreeSitterExtractor.ts applications/tech-extractor/src/extractors/TreeSitterExtractor.test.ts applications/tech-extractor/src/config/sdkCallPatterns.json
git commit -m "feat(tech-extractor): add TreeSitter import + SDK-call extraction"
```

---

## Task 13: TechExtractOrchestrator (fault isolation + resolve + persist)

**Files:**
- Create: `applications/tech-extractor/src/orchestrator/TechExtractOrchestrator.ts`
- Test: `applications/tech-extractor/src/orchestrator/TechExtractOrchestrator.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
/** @format */
import { describe, it, expect, jest } from '@jest/globals';
import { TechExtractOrchestrator } from './TechExtractOrchestrator.js';
import { OntologyResolver } from '@bedrock/shared';
import type { Extractor } from '../extractors/Extractor.js';

function fakeExtractor(name: string, rows: unknown[], throws = false): Extractor {
    return {
        name,
        extract: jest.fn(async () => { if (throws) throw new Error('boom'); return rows as never; }),
    };
}

describe('TechExtractOrchestrator.run', () => {
    const resolver = new OntologyResolver(new Map([['react', 'id-react']]));

    it('isolates a failing extractor and still persists the others', async () => {
        const evidenceRepo = { insertMany: jest.fn(async () => {}) };
        const candidateRepo = { upsert: jest.fn(async () => {}) };
        const good = fakeExtractor('good', [
            { raw_name: 'React', ecosystem: 'npm', source_layer: 'syft', file_path: 'package.json' },
            { raw_name: 'mystery', ecosystem: 'npm', source_layer: 'syft', file_path: 'package.json' },
        ]);
        const bad = fakeExtractor('bad', [], true);

        const orch = new TechExtractOrchestrator(resolver, evidenceRepo as never, candidateRepo as never);
        const result = await orch.run({
            userId: 'u1', repoFullName: 'o/r', commitSha: 'abc', ontologyVersion: 3, extractors: [good, bad],
        });

        const persisted = (evidenceRepo.insertMany as jest.Mock).mock.calls[0][1] as { technologyId: string | null; rawName: string }[];
        expect(persisted.find(r => r.rawName === 'React')!.technologyId).toBe('id-react');
        expect(persisted.find(r => r.rawName === 'mystery')!.technologyId).toBeNull();
        expect(candidateRepo.upsert).toHaveBeenCalledTimes(1);
        expect(result.failedExtractors).toEqual(['bad']);
        expect(result.matched).toBe(1);
        expect(result.unmatched).toBe(1);
        expect(result.canonicalIds.has('id-react')).toBe(true);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn workspace @bedrock/tech-extractor jest src/orchestrator/TechExtractOrchestrator.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
/** @format */
import {
    OntologyResolver, CONFIDENCE_BY_LAYER, type TechnologyEvidenceRow,
} from '@bedrock/shared';
import type { TechnologyEvidenceRepository, TechnologyCandidateRepository } from '@bedrock/shared';
import type { Extractor } from '../extractors/Extractor.js';

export interface OrchestratorRunInput {
    userId:          string;
    repoFullName:    string;
    commitSha:       string;
    ontologyVersion: number;
    extractors:      Extractor[];
}

export interface OrchestratorResult {
    matched:          number;
    unmatched:        number;
    failedExtractors: string[];
    canonicalIds:     Set<string>;   // distinct matched technology ids (for parity)
}

/** Strip non-alphanumerics for candidate grouping. */
function normalizeForCandidate(raw: string): string {
    return raw.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export class TechExtractOrchestrator {
    constructor(
        private readonly resolver: OntologyResolver,
        private readonly evidenceRepo: TechnologyEvidenceRepository,
        private readonly candidateRepo: TechnologyCandidateRepository,
    ) {}

    async run(input: OrchestratorRunInput): Promise<OrchestratorResult> {
        const failedExtractors: string[] = [];
        const settled = await Promise.allSettled(
            input.extractors.map(async (e) => ({ name: e.name, rows: await e.extract('') })),
        );

        const evidence: TechnologyEvidenceRow[] = [];
        const canonicalIds = new Set<string>();
        const candidatesSeen = new Set<string>();
        let matched = 0, unmatched = 0;

        for (let i = 0; i < settled.length; i++) {
            const s = settled[i];
            if (s.status === 'rejected') { failedExtractors.push(input.extractors[i].name); continue; }
            for (const r of s.value.rows) {
                const techId = this.resolver.resolve(r.raw_name);
                evidence.push({
                    userId: input.userId, repoFullName: input.repoFullName, commitSha: input.commitSha,
                    technologyId: techId, rawName: r.raw_name, ecosystem: r.ecosystem ?? null,
                    sourceLayer: r.source_layer, filePath: r.file_path,
                    lineStart: r.line_start ?? null, lineEnd: r.line_end ?? null,
                    confidence: CONFIDENCE_BY_LAYER[r.source_layer], ontologyVersion: input.ontologyVersion,
                });
                if (techId) { matched++; canonicalIds.add(techId); }
                else {
                    unmatched++;
                    const norm = normalizeForCandidate(r.raw_name);
                    const key = `${norm}|${r.ecosystem ?? 'unknown'}`;
                    if (!candidatesSeen.has(key)) {
                        candidatesSeen.add(key);
                        await this.candidateRepo.upsert({
                            rawName: r.raw_name, normalizedName: norm, ecosystem: r.ecosystem,
                            userId: input.userId, repoFullName: input.repoFullName, filePath: r.file_path,
                        });
                    }
                }
            }
        }

        await this.evidenceRepo.insertMany(input.userId, evidence);
        return { matched, unmatched, failedExtractors, canonicalIds };
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn workspace @bedrock/tech-extractor jest src/orchestrator/TechExtractOrchestrator.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add applications/tech-extractor/src/orchestrator/TechExtractOrchestrator.ts applications/tech-extractor/src/orchestrator/TechExtractOrchestrator.test.ts
git commit -m "feat(tech-extractor): add orchestrator with fault isolation"
```

---

## Task 14: ParityReporter

**Files:**
- Create: `applications/tech-extractor/src/parity/ParityReporter.ts`
- Test: `applications/tech-extractor/src/parity/ParityReporter.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn workspace @bedrock/tech-extractor jest src/parity/ParityReporter.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
/** @format */
import type { OntologyResolver } from '@bedrock/shared';

export interface ParityResult {
    l1CanonicalCount:     number;
    llmCanonicalCount:    number;
    llmUnresolvableCount: number;
    intersectionCount:    number;
    recall:               number;
    l1OnlyExamples:       string[];
    llmOnlyExamples:      string[];
}

/**
 * Compare L1 canonical ids against the LLM enricher's free-form technology
 * strings, resolving the LLM strings through the SAME resolver so the metric
 * isn't polluted by the LLM's un-canonicalised noise.
 */
export function computeParity(
    resolver: OntologyResolver,
    l1CanonicalIds: Set<string>,
    llmTechnologies: string[],
): ParityResult {
    const llmResolved = new Set<string>();
    let unresolvable = 0;
    const idToName = new Map<string, string>(); // id -> original llm string
    for (const t of llmTechnologies) {
        const id = resolver.resolve(t);
        if (id) { llmResolved.add(id); if (!idToName.has(id)) idToName.set(id, t); }
        else unresolvable++;
    }

    let intersection = 0;
    const llmOnly: string[] = [];
    for (const id of llmResolved) {
        if (l1CanonicalIds.has(id)) intersection++;
        else llmOnly.push(idToName.get(id)!);
    }
    const l1Only = [...l1CanonicalIds].filter((id) => !llmResolved.has(id));

    const denom = llmResolved.size;
    return {
        l1CanonicalCount:     l1CanonicalIds.size,
        llmCanonicalCount:    llmResolved.size,
        llmUnresolvableCount: unresolvable,
        intersectionCount:    intersection,
        recall:               denom === 0 ? 1 : intersection / denom,
        l1OnlyExamples:       l1Only.slice(0, 25),
        llmOnlyExamples:      llmOnly.slice(0, 25),
    };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn workspace @bedrock/tech-extractor jest src/parity/ParityReporter.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add applications/tech-extractor/src/parity/ParityReporter.ts applications/tech-extractor/src/parity/ParityReporter.test.ts
git commit -m "feat(tech-extractor): add parity computation"
```

---

## Task 15: Job entrypoint `run-tech-extract.ts`

**Files:**
- Create: `applications/tech-extractor/src/run-tech-extract.ts`

> No unit test for the entrypoint (it wires I/O); exercised by Task 16's integration test and the Job in Plan 3. Keep it thin — all logic lives in tested units.

- [ ] **Step 1: Write the entrypoint** (mirror `run-ingestion.ts`: observability bootstrap, try/finally, time-boxed teardown)

```ts
/** @format */
import { Pool } from 'pg';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
    OntologyResolver, TechnologyOntologyRepository, TechnologyEvidenceRepository,
    TechnologyCandidateRepository, TechnologyParityRunRepository,
    bootstrapK8sObservability, pushFinalMetrics,
} from '@bedrock/shared';
import { Counter, Gauge } from 'prom-client';

import { parseEnv } from './env.js';
import { fetchTarball } from './tarball/fetchTarball.js';
import { safeExtract } from './tarball/safeExtract.js';
import { walkTextFiles } from './util/fileWalk.js';
import { SyftExtractor } from './extractors/SyftExtractor.js';
import { TreeSitterExtractor } from './extractors/TreeSitterExtractor.js';
import { parseDockerfile } from './extractors/iac/DockerfileParser.js';
import { parseK8sManifest } from './extractors/iac/K8sManifestParser.js';
import { parseTerraform } from './extractors/iac/TerraformParser.js';
import { parseGithubActions } from './extractors/iac/GithubActionsParser.js';
import { parseReadme } from './extractors/iac/ReadmeParser.js';
import type { Extractor, RawTechnologyEvidence } from './extractors/Extractor.js';
import { TechExtractOrchestrator } from './orchestrator/TechExtractOrchestrator.js';
import { computeParity } from './parity/ParityReporter.js';

const MAX_TARBALL_BYTES = Number(process.env.MAX_TARBALL_BYTES ?? 200 * 1024 * 1024);

const obs = bootstrapK8sObservability({ serviceName: 'tech-extractor' });
const log = obs.logger;

const recallGauge = new Gauge({
    name: 'tech_extractor_layer1_recall', help: 'L1 vs LLM technology recall.',
    labelNames: ['repo'] as const, registers: [obs.registry],
});
const extractorFailed = new Counter({
    name: 'tech_extractor_extractor_failed_total', help: 'Extractor failures by name.',
    labelNames: ['extractor'] as const, registers: [obs.registry],
});

async function withTimeout(p: Promise<unknown>, ms: number, label: string): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => { timer = setTimeout(() => { log.warn({ label }, 'teardown timed out'); resolve(); }, ms); });
    try { await Promise.race([p.then(() => undefined).catch(() => undefined), timeout]); }
    finally { if (timer) clearTimeout(timer); }
}

/** All IaC parsers as one fault-isolation unit over walked files. */
function iacExtractor(rootDir: string, files: string[]): Extractor {
    return {
        name: 'iac',
        async extract(): Promise<RawTechnologyEvidence[]> {
            const out: RawTechnologyEvidence[] = [];
            for (const rel of files) {
                const base = path.basename(rel).toLowerCase();
                const src = await fs.readFile(path.join(rootDir, rel), 'utf-8');
                if (base.startsWith('dockerfile')) out.push(...parseDockerfile(src, rel));
                else if (rel.includes('.github/workflows/')) out.push(...parseGithubActions(src, rel));
                else if (rel.endsWith('.tf') || rel.endsWith('.hcl')) out.push(...parseTerraform(src, rel));
                else if (rel.endsWith('.yaml') || rel.endsWith('.yml')) out.push(...parseK8sManifest(src, rel));
                else if (base === 'readme.md') out.push(...parseReadme(src, rel));
            }
            return out;
        },
    };
}

async function main(): Promise<void> {
    const env = parseEnv();
    const sha = env.commitSha ?? 'HEAD';
    log.info({ userId: env.userId, repo: env.repoFullName, sha }, 'tech-extract.start');

    const pool = new Pool({ ...env.pg, max: 3 });
    const ontologyRepo  = new TechnologyOntologyRepository(pool);
    const evidenceRepo  = new TechnologyEvidenceRepository(pool);
    const candidateRepo = new TechnologyCandidateRepository(pool);
    const parityRepo    = new TechnologyParityRunRepository(pool);

    try {
        if (env.commitSha && await evidenceRepo.hasEvidenceForCommit(env.userId, env.repoFullName, env.commitSha)) {
            log.info({ repo: env.repoFullName, sha }, 'short-circuit: evidence exists');
            return;
        }

        const tarPath = path.join(env.workDir, 'repo.tar.gz');
        const extractDir = path.join(env.workDir, 'tree');
        await fs.mkdir(extractDir, { recursive: true });
        try {
            await fetchTarball(env.repoFullName, env.commitSha, env.githubToken, tarPath, MAX_TARBALL_BYTES);
        } catch (e) {
            if (String(e).includes('repo_too_large')) { log.warn({ repo: env.repoFullName }, 'repo_too_large'); return; }
            throw e;
        }
        await safeExtract(tarPath, extractDir);

        const files = await walkTextFiles(extractDir);
        const readFile = (rel: string) => fs.readFile(path.join(extractDir, rel), 'utf-8');

        const ontologyVersion = await ontologyRepo.currentVersion();
        const resolver = new OntologyResolver(await ontologyRepo.loadAliasMap());

        const extractors: Extractor[] = [
            new SyftExtractor(),
            new TreeSitterExtractor(readFile, files),
            iacExtractor(extractDir, files),
        ];

        const orch = new TechExtractOrchestrator(resolver, evidenceRepo, candidateRepo);
        const result = await orch.run({
            userId: env.userId, repoFullName: env.repoFullName, commitSha: sha, ontologyVersion, extractors,
        });
        for (const name of result.failedExtractors) extractorFailed.inc({ extractor: name });

        // Parity vs the LLM enricher's per-chunk technologies (GIN-indexed TEXT[]).
        let llmTechs: string[] = [];
        try {
            const { rows } = await pool.query<{ tech: string }>(
                `SELECT DISTINCT unnest(technologies) AS tech
                 FROM document_embeddings WHERE user_id = $1::uuid AND repo_full_name = $2`,
                [env.userId, env.repoFullName],
            );
            llmTechs = rows.map((r) => r.tech);
        } catch (e) {
            log.warn({ err: String(e) }, 'parity: failed to read document_embeddings.technologies');
        }

        const parity = computeParity(resolver, result.canonicalIds, llmTechs);
        recallGauge.set({ repo: env.repoFullName }, parity.recall);
        await parityRepo.insert({
            userId: env.userId, repoFullName: env.repoFullName, commitSha: sha, ontologyVersion,
            l1CanonicalCount: parity.l1CanonicalCount, llmCanonicalCount: parity.llmCanonicalCount,
            llmUnresolvableCount: parity.llmUnresolvableCount, intersectionCount: parity.intersectionCount,
            recall: parity.recall, l1OnlyExamples: parity.l1OnlyExamples, llmOnlyExamples: parity.llmOnlyExamples,
        });

        log.info({
            repo: env.repoFullName, sha, matched: result.matched, unmatched: result.unmatched,
            recall: parity.recall, failed: result.failedExtractors, llm_only: parity.llmOnlyExamples,
        }, 'tech-extract.complete');
    } finally {
        await withTimeout(pool.end(), 10_000, 'pg-pool');
        await withTimeout(
            pushFinalMetrics(obs.registry, 'tech-extractor', `${env.userId}_${env.repoFullName.replace('/', '_')}`),
            8_000, 'pushgateway',
        );
        await withTimeout(obs.shutdown(), 10_000, 'otel-shutdown');
    }
}

main().then(() => process.exit(0)).catch((err) => { log.error({ err }, 'failed'); process.exit(1); });
```

> Verify the exact `document_embeddings` columns at implementation time (`user_id`, `repo_full_name`, `technologies`) and that `bootstrapK8sObservability` / `pushFinalMetrics` are exported from `@bedrock/shared` (they are used by `run-ingestion.ts`). Adjust the parity query to the real schema.

- [ ] **Step 2: Build the app**

Run: `yarn workspace @bedrock/tech-extractor build`
Expected: tsc emits `dist/run-tech-extract.js`.

- [ ] **Step 3: Commit**

```bash
git add applications/tech-extractor/src/run-tech-extract.ts
git commit -m "feat(tech-extractor): add Job entrypoint wiring"
```

---

## Task 16: Full suite + in-process integration

**Files:**
- Create: `applications/tech-extractor/src/__tests__/integration.test.ts`

- [ ] **Step 1: Write an in-process integration test** (orchestrator over fixture extractors + in-memory repos; no DB, no network)

```ts
/** @format */
import { describe, it, expect, jest } from '@jest/globals';
import { OntologyResolver } from '@bedrock/shared';
import { TechExtractOrchestrator } from '../orchestrator/TechExtractOrchestrator.js';
import { computeParity } from '../parity/ParityReporter.js';
import { parseDockerfile } from '../extractors/iac/DockerfileParser.js';
import type { Extractor } from '../extractors/Extractor.js';

describe('layer-1 end-to-end (in-process)', () => {
    it('extracts -> resolves -> reports parity', async () => {
        const resolver = new OntologyResolver(new Map([['node', 'id-node'], ['react', 'id-react']]));
        const dockerEx: Extractor = { name: 'iac', extract: async () => parseDockerfile('FROM node:22-alpine', 'Dockerfile') };
        const syftEx: Extractor = { name: 'syft', extract: async () => [{ raw_name: 'react', ecosystem: 'npm', source_layer: 'syft', file_path: 'package.json' }] };

        const evidenceRepo = { insertMany: jest.fn(async () => {}) };
        const candidateRepo = { upsert: jest.fn(async () => {}) };
        const orch = new TechExtractOrchestrator(resolver, evidenceRepo as never, candidateRepo as never);
        const result = await orch.run({ userId: 'u1', repoFullName: 'o/r', commitSha: 'abc', ontologyVersion: 1, extractors: [dockerEx, syftEx] });

        expect(result.matched).toBe(2);
        expect(result.canonicalIds.has('id-node')).toBe(true);

        const parity = computeParity(resolver, result.canonicalIds, ['react', 'node', 'kafka']);
        expect(parity.recall).toBeCloseTo(1.0);     // node + react both caught
        expect(parity.llmUnresolvableCount).toBe(1); // kafka not in this resolver
    });
});
```

- [ ] **Step 2: Run the full workspace suite**

Run: `yarn workspace @bedrock/tech-extractor test`
Expected: all tests pass (unit + integration).

- [ ] **Step 3: Type-check**

Run: `yarn workspace @bedrock/tech-extractor lint`
Expected: zero type errors.

- [ ] **Step 4: Commit**

```bash
git add applications/tech-extractor/src/__tests__/integration.test.ts
git commit -m "test(tech-extractor): add in-process layer-1 integration test"
```

---

## Self-Review

**Spec coverage (Plan 2 portion):**
- Tarball acquisition + size cap + `repo_too_large` → Tasks 3, 15 ✓
- Safe extraction (zip-slip/symlink/absolute/entry-cap, strip 1) → Task 4 ✓
- Text pre-filter (issue #8) → Task 5 ✓
- Common `Extractor` interface (issue #7) → Task 2 ✓
- Syft extractor (execFile, no shell) → Task 6 ✓
- Tree-sitter imports + data-driven SDK patterns (issue #6) → Task 12 ✓
- IaC parsers (Dockerfile/k8s/Terraform/GH Actions/README) → Tasks 7–11 ✓
- Fault isolation via `Promise.allSettled` + metric (issue #5) → Tasks 13, 15 ✓
- Resolve + persist evidence/candidates, per-layer confidence → Task 13 ✓
- Commit-SHA short-circuit → Task 15 ✓
- Parity compute + persist `technology_parity_runs` + recall gauge (issue #10, open-q #3) → Tasks 14, 15 ✓
- Observability + time-boxed teardown → Task 15 ✓
- *Deferred to Plan 3:* Dockerfile (Syft binary + wasm grammars), Helm, ArgoCD, trigger, concurrent-run Job naming. *Deferred to Phase 2:* live Tree-sitter wasm AST replacing the regex import pass.

**Placeholder scan:** none — every code step is complete. Three explicit "verify against real schema/version at implementation" notes (tar v7 options, `document_embeddings` columns, dep versions) are verification instructions, not placeholders.

**Type consistency:** `Extractor`/`RawTechnologyEvidence` (shared), `OrchestratorRunInput`/`OrchestratorResult.canonicalIds`, `ParityResult`, `computeParity(resolver, Set<string>, string[])`, repo method names (`insertMany`, `upsert`, `hasEvidenceForCommit`, `loadAliasMap`, `currentVersion`, `insert`) all match Plan 1's definitions and are used consistently.
